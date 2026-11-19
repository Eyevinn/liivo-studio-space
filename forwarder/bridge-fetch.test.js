'use strict';
// Tests for bridge-fetch.js against a fake gateway on loopback serving a tarball built in the test
// and a fake signer on a unix socket (the edit proxy's real signer is tested in bridge-routing.test.js).
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fetchBridge, walkTar, checkMembers, validManifest, gatewayBase, Unavailable } = require('./bridge-fetch.js');
const { tgz, sha256, bridgePackage } = require('./tar.testutil.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function listen(server, ...args) {
  return new Promise((resolve) => {
    server.listen(...args, () => resolve(server.address()));
    cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  });
}

// A workspace home with a signer that answers 409 `conflicts` times, then a token naming the call it was.
async function setup({ conflicts = 0, gateway } = {}) {
  const home = fs.mkdtempSync(path.join('/tmp', 'lsb-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.liivo'), { recursive: true });
  const calls = { signer: 0, manifest: 0, tgz: 0, tokens: [] };
  const sock = path.join(home, '.liivo', 'sign.sock');
  const signer = http.createServer((req, res) => {
    req.resume();
    calls.signer++;
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/bridge-token') { res.writeHead(404); return res.end('{}'); }
    if (calls.signer <= conflicts) { res.writeHead(409); return res.end('{"error":"tenant not known yet"}'); }
    res.end(JSON.stringify({ token: `tok-${calls.signer}`, gatewayUrl: gateway.url() }));
  });
  await listen(signer, sock);
  return { home, sock, calls, bridgeDir: path.join(home, '.liivo', 'bridge') };
}

// The gateway: `state` decides what it answers; every request must carry a token the signer handed out.
async function gateway(state) {
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, auth: req.headers.authorization });
    const auth = /^Bearer (tok-\d+)$/.exec(req.headers.authorization || '');
    if (!auth) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (state.status) { res.writeHead(state.status); return res.end(`{"error":"x"}`); }
    if (req.url === '/api/bridge/manifest') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state.manifest)); }
    if (req.url === `/api/bridge/${state.manifest.version}.tgz`) { state.downloads++; res.setHeader('content-type', 'application/gzip'); return res.end(state.body); }
    res.writeHead(404); res.end('{"error":"unknown-version"}');
  });
  const addr = await listen(server, 0, '127.0.0.1');
  state.requests = [];
  state.downloads = 0;
  return { url: () => `http://127.0.0.1:${addr.port}`, port: addr.port };
}

// A gateway that serves `version` as it packs it.
function serve(version, body = bridgePackage(version)) {
  return { manifest: { protocol: 1, version, sha256: sha256(body), size: body.length }, body, status: 0 };
}

async function run(state, over = {}) {
  const gw = { url: () => '' };
  const real = await gateway(state);
  gw.url = real.url;
  const w = await setup({ gateway: gw, ...over });
  const fetchOpts = { home: w.home, pollMs: 5, allowLoopbackHttp: true, log: () => {} };
  return { ...w, gw, fetch: (o = {}) => fetchBridge({ ...fetchOpts, ...o }) };
}

const logs = [];
const quiet = (m) => logs.push(m);

test('fetches the bridge, verifies it, extracts it and a node process runs it from current/', async () => {
  const state = serve('v1');
  const w = await run(state);
  const version = await w.fetch({ log: quiet });
  assert.strictEqual(version, 'v1');
  assert.strictEqual(fs.readlinkSync(path.join(w.bridgeDir, 'current')), 'v1');
  assert.ok(fs.existsSync(path.join(w.bridgeDir, 'v1.tgz')));
  assert.strictEqual(fs.readFileSync(path.join(w.bridgeDir, 'v1.sha256'), 'utf8').trim(), state.manifest.sha256);
  assert.ok(fs.existsSync(path.join(w.bridgeDir, 'current', 'package', 'node_modules', `${'deeply-nested-'.repeat(8)}`, 'index.js')), 'a long path is extracted');
  assert.deepStrictEqual(state.requests.map((r) => r.url), ['/api/bridge/manifest', '/api/bridge/v1.tgz']);
  assert.ok(state.requests.every((r) => /^Bearer tok-\d+$/.test(r.auth)), 'every gateway call carries the signer\'s token');
  assert.notStrictEqual(state.requests[0].auth, state.requests[1].auth, 'the download asks for a fresh token');

  // run it the way the supervisor does
  const port = 41000 + (process.pid % 1000);
  const child = spawn(process.execPath, [path.join(w.bridgeDir, 'current', 'package', 'server.mjs')], {
    env: { PATH: process.env.PATH, HOME: w.home, LIIVO_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanups.push(() => child.kill());
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }).on('error', reject));
  assert.match(body, /^bridge .*current\/package\/server\.mjs$/);
});

test('the signer answers 409 twice, then 200: the fetcher polls and carries on, and the wait is logged once', async () => {
  const state = serve('v1');
  const w = await run(state, { conflicts: 2 });
  const seen = [];
  assert.strictEqual(await w.fetch({ log: (m) => seen.push(m) }), 'v1');
  assert.strictEqual(w.calls.signer, 4, 'two polls that were refused, one for the manifest, one fresh for the download');
  assert.strictEqual(seen.filter((m) => /waiting for the gateway/.test(m)).length, 1);
});

test('a second start reuses the cached tarball: the manifest is asked for, the tarball is not downloaded again', async () => {
  const state = serve('v1');
  const w = await run(state);
  await w.fetch();
  const before = state.downloads;
  assert.strictEqual(await w.fetch(), 'v1');
  assert.strictEqual(state.downloads, before);
  assert.strictEqual(state.requests.filter((r) => r.url === '/api/bridge/manifest').length, 2);
  // the cached copy is extracted fresh each start
  fs.writeFileSync(path.join(w.bridgeDir, 'current', 'package', 'stray.txt'), 'x');
  await w.fetch();
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current', 'package', 'stray.txt')));
});

test('a tarball that does not hash to the manifest is never extracted nor kept, with no cache there is no bridge', async () => {
  const state = serve('v1');
  state.body = bridgePackage('v1', { extra: [{ name: 'package/tampered.txt', data: 'x' }] });
  state.manifest.size = state.body.length; // same size, other bytes: only the hash can tell
  const w = await run(state);
  await assert.rejects(w.fetch(), (e) => e instanceof Unavailable && /no verified bridge in the cache/.test(e.message));
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')));
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'v1.tgz')));
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'v1')));
  assert.deepStrictEqual(fs.readdirSync(w.bridgeDir), [], 'no .part file is left');
});

test('with a verified cache, a sha256 mismatch falls back to the cached version', async () => {
  const state = serve('v1');
  const w = await run(state);
  await w.fetch();
  Object.assign(state, serve('v2'));
  state.body = bridgePackage('v2', { extra: [{ name: 'package/tampered.txt', data: 'x' }] });
  state.manifest.size = state.body.length;
  assert.strictEqual(await w.fetch(), 'v1');
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'v2.tgz')));
  assert.strictEqual(fs.readlinkSync(path.join(w.bridgeDir, 'current')), 'v1');
});

test('a cached tarball whose bytes no longer match its recorded hash is not run', async () => {
  const state = serve('v1');
  const w = await run(state);
  await w.fetch();
  fs.writeFileSync(path.join(w.bridgeDir, 'v1.tgz'), bridgePackage('v1', { extra: [{ name: 'package/evil.txt', data: 'x' }] }));
  fs.rmSync(path.join(w.bridgeDir, 'current'));
  state.status = 503;
  await assert.rejects(w.fetch(), (e) => e instanceof Unavailable);
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')));
});

for (const status of [401, 429, 503]) {
  test(`the gateway answers ${status}: no cache means no bridge (exit 3), a verified cache is used`, async () => {
    const state = serve('v1');
    const w = await run(state);
    state.status = status;
    await assert.rejects(w.fetch(), (e) => e instanceof Unavailable && new RegExp(`answered ${status}`).test(e.message));
    assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')));
    state.status = 0;
    await w.fetch(); // now there is a cache
    fs.rmSync(path.join(w.bridgeDir, 'current'));
    state.status = status;
    assert.strictEqual(await w.fetch(), 'v1');
    assert.strictEqual(fs.readlinkSync(path.join(w.bridgeDir, 'current')), 'v1');
  });
}

test('an unreachable gateway: the verified cache, else exit 3', async () => {
  const state = serve('v1');
  const w = await run(state);
  await w.fetch();
  fs.rmSync(path.join(w.bridgeDir, 'current'));
  const dead = http.createServer();
  const addr = await listen(dead, 0, '127.0.0.1');
  await new Promise((r) => dead.close(r));
  w.gw.url = () => `http://127.0.0.1:${addr.port}`;
  assert.strictEqual(await w.fetch(), 'v1');
  fs.rmSync(w.bridgeDir, { recursive: true, force: true });
  await assert.rejects(w.fetch(), Unavailable);
});

test('protocol 2 is refused and nothing is downloaded; the cached bridge stays', async () => {
  const state = serve('v1');
  const w = await run(state);
  await w.fetch();
  state.manifest = { ...serve('v2').manifest, protocol: 2 };
  const downloads = state.downloads;
  assert.strictEqual(await w.fetch(), 'v1');
  assert.strictEqual(state.downloads, downloads);
  fs.rmSync(w.bridgeDir, { recursive: true, force: true });
  await assert.rejects(w.fetch(), (e) => /protocol 2/.test(e.message));
});

test('an oversize manifest is refused; a tarball larger than its manifest is cut off', async () => {
  const state = serve('v1');
  state.manifest.size = 21 * 1024 * 1024;
  const w = await run(state);
  await assert.rejects(w.fetch(), (e) => /size is not within/.test(e.message));
  assert.strictEqual(state.downloads, 0);
  // the gateway says 100 bytes and sends the whole tarball
  state.manifest.size = 100;
  await assert.rejects(w.fetch(), (e) => /larger than the manifest/.test(e.message));
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'v1.tgz')));
});

test('a version that is not a plain version name is refused (it becomes a path)', () => {
  for (const version of ['../x', '..', '.hidden', 'a/b', '', 'x'.repeat(65), 'a b']) {
    assert.ok(validManifest({ protocol: 1, version, sha256: 'a'.repeat(64), size: 10 }), JSON.stringify(version));
  }
  assert.strictEqual(validManifest({ protocol: 1, version: 'dev-1a2b.3_c', sha256: 'a'.repeat(64), size: 10 }), null);
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    assert.ok(validManifest({ protocol: 1, version: 'v1', sha256, size: 10 }), sha256);
  }
});

test('members outside package/ are refused before anything is extracted, even when the hash matches', async () => {
  const bad = {
    'a ../ member': { name: 'package/../evil.txt', data: 'x' },
    'a member outside package/': { name: 'evil.txt', data: 'x' },
    'a path that leaves through a ../ first': { name: '../evil.txt', data: 'x' },
    'an absolute path': { name: '/tmp/evil.txt', data: 'x' },
    'a symlink': { name: 'package/link', type: '2', link: '/etc/passwd' },
    'a hard link': { name: 'package/hard', type: '1', link: 'package/server.mjs' },
    'a device': { name: 'package/dev', type: '3' },
    'a dot segment': { name: 'package/./x', data: 'x' },
  };
  for (const [what, member] of Object.entries(bad)) {
    const body = bridgePackage('v1', { extra: [member] });
    const w = await run(serve('v1', body));
    await assert.rejects(w.fetch(), Unavailable, what);
    assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')), what);
    assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'v1')), `${what}: nothing is extracted`);
    assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'evil.txt')) && !fs.existsSync(path.join(w.home, 'evil.txt')) && !fs.existsSync('/tmp/evil.txt'), what);
  }
});

test('walkTar and checkMembers: a plain package passes (the passing path), anything else does not', () => {
  const members = walkTar(bridgePackage('v1'));
  assert.doesNotThrow(() => checkMembers(members));
  assert.ok(members.some((m) => m.name.length > 100), 'the long name is read from its L entry');
  assert.throws(() => checkMembers([]), /empty/);
  assert.throws(() => walkTar(Buffer.from('not gzip')), /not a gzip/);
});

test('walkTar takes the LAST pax path record, as tar does, so a duplicate-path archive is refused by the member check', () => {
  const dup = tgz([{ name: 'package/' }, { name: 'package/ok.txt', data: 'x', pax: [['path', 'package/ok.txt'], ['path', '../../escaped.txt']] }]);
  const members = walkTar(dup);
  assert.deepStrictEqual(members.map((m) => m.name), ['package/', '../../escaped.txt']);
  assert.throws(() => checkMembers(members), /outside package/);
  // the passing path: a single pax path record, and a later one that stays inside package/
  const ok = walkTar(tgz([{ name: 'package/' }, { name: 'package/a.txt', data: 'x', pax: [['path', 'package/b.txt'], ['mtime', '1'], ['path', 'package/c.txt']] }]));
  assert.strictEqual(ok[1].name, 'package/c.txt');
  assert.doesNotThrow(() => checkMembers(ok));
});

test('a pax header that carries size or linkpath, or is malformed, is refused', () => {
  for (const pax of [[['size', '5']], [['linkpath', '/etc/passwd']], [['path', 'package/a.txt'], ['size', '0']]]) {
    assert.throws(() => walkTar(tgz([{ name: 'package/' }, { name: 'package/a.txt', data: 'x', pax }])), /size or linkpath/);
  }
  const bad = tgz([{ name: 'package/' }, { name: 'package/a.txt', data: 'x', pax: [['path', 'package/a.txt']] }]);
  const raw = zlib.gunzipSync(bad);
  raw[1024 + 1] = 0x39; // corrupt the record length digits in the pax body
  assert.throws(() => walkTar(zlib.gzipSync(raw)), /pax header is malformed/);
});

test('a package whose VERSION.json names another version, or that has no server.mjs, is not installed', async () => {
  let body = tgz([{ name: 'package/' }, { name: 'package/VERSION.json', data: '{"version":"v9","protocol":1}' }, { name: 'package/server.mjs', data: 'x' }]);
  let w = await run(serve('v1', body));
  await assert.rejects(w.fetch(), Unavailable);
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')));
  body = tgz([{ name: 'package/' }, { name: 'package/VERSION.json', data: '{"version":"v1","protocol":1}' }]);
  w = await run(serve('v1', body));
  await assert.rejects(w.fetch(), Unavailable);
  assert.ok(!fs.existsSync(path.join(w.bridgeDir, 'current')));
});

test('only the two newest tarballs are kept, with their records and directories', async () => {
  const state = serve('v1');
  const w = await run(state);
  for (const v of ['v1', 'v2', 'v3']) {
    Object.assign(state, serve(v));
    await w.fetch();
    await new Promise((r) => setTimeout(r, 15)); // distinct record times
  }
  assert.deepStrictEqual(fs.readdirSync(w.bridgeDir).sort(), ['current', 'v2', 'v2.sha256', 'v2.tgz', 'v3', 'v3.sha256', 'v3.tgz']);
  assert.strictEqual(fs.readlinkSync(path.join(w.bridgeDir, 'current')), 'v3');
});

test('the gateway URL must be https; plain http only for loopback and only when the test flag is set', () => {
  assert.strictEqual(gatewayBase('https://studio.dev.liivo.ai/', false), 'https://studio.dev.liivo.ai');
  assert.strictEqual(gatewayBase('http://127.0.0.1:8080', true), 'http://127.0.0.1:8080');
  assert.throws(() => gatewayBase('http://127.0.0.1:8080', false), /not https/);
  assert.throws(() => gatewayBase('http://studio.dev.liivo.ai', true), /not https/);
  assert.throws(() => gatewayBase('https://u:p@studio.dev.liivo.ai', false), /credentials/);
  assert.throws(() => gatewayBase('nonsense', false), /not a URL/);
});

test('a signer that is not there at all is waited for; one that refuses for another reason is not', async () => {
  const state = serve('v1');
  const w = await run(state);
  // no socket: the forwarder has not started yet, so the fetcher asks again
  let n = 0;
  const sockPath = path.join(w.home, '.liivo', 'sign.sock');
  fs.renameSync(sockPath, `${sockPath}.away`);
  const p = w.fetch({
    wait: async () => {
      if (++n === 2) fs.renameSync(`${sockPath}.away`, sockPath); // the signer appears on the second wait
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  assert.strictEqual(await p, 'v1');
  assert.ok(n >= 2);
  // a signer without a key: a refusal, not a wait
  const dir = fs.mkdtempSync(path.join('/tmp', 'lsb-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.liivo'));
  const s2 = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end('{"error":"HANDOFF_KEY is not set"}'); });
  await listen(s2, path.join(dir, '.liivo', 'sign.sock'));
  await assert.rejects(fetchBridge({ home: dir, pollMs: 5, allowLoopbackHttp: true }), (e) => e instanceof Unavailable && /signer answered 503/.test(e.message));
});
