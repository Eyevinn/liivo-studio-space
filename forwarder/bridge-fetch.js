'use strict';
// Fetches the Liivo Studio bridge at every workspace start (amendment 6, section 5). Run by the
// entrypoint's supervisor as `node bridge-fetch.js`; node:* and the system `tar` only.
//
//   1. Ask the edit proxy's signer (~/.liivo/sign.sock, POST /bridge-token) for an `aud` bridge token.
//      The signer answers 409 until the gateway has taught the workspace who it belongs to, so the
//      fetcher asks again every 2 s: that wait is not a gateway failure.
//   2. GET <gateway>/api/bridge/manifest -> { protocol, version, sha256, size }, validated.
//   3. Reuse ~/.liivo/bridge/<version>.tgz when its sha256 is the manifest's, else download it (a fresh
//      token), stop at the manifest's size, hash while reading, compare, rename. The sha256 of a
//      verified download is recorded in <version>.sha256.
//   4. Check every member of the archive before anything is extracted (only `package/...`, no `..`, no
//      absolute path, no link or device), extract into a fresh directory, check VERSION.json, point
//      `current` at it, keep the two newest tarballs.
//   A refusal (401, 429, any 503, protocol other than 1, an oversize or malformed manifest, a failed
//   download, a hash that differs) or no gateway: the newest cached tarball whose recorded sha256 still
//   matches its bytes, else exit 3. A file whose sha256 did not match is never extracted and never run.
//
// Exit codes: 0 a bridge is in place (its version is printed), 2 the fetcher cannot work at all
// (no HOME), 3 no verified bridge is available now.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const PROTOCOL = 1;
const MAX_SIZE = 20 * 1024 * 1024;
const MAX_TAR = 256 * 1024 * 1024;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const KEEP = 2;

class Unavailable extends Error {}

const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the archive ----

// Every member of a gzip'd tar as { name, type }, read from the headers (the tar program is not asked to
// list: what is checked here is what a header says, and an entry kind that is not a plain file or directory
// is refused). Handles GNU long names (`L`) and pax `path` records (`x`), which node_modules paths need.
function walkTar(gz) {
  let data;
  try {
    data = zlib.gunzipSync(gz, { maxOutputLength: MAX_TAR });
  } catch (e) {
    throw new Error(`not a gzip tar within ${MAX_TAR} bytes (${e.code || e.message})`);
  }
  const members = [];
  let pending = null;
  let off = 0;
  const cstr = (b) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString('utf8');
  };
  while (off + 512 <= data.length) {
    const h = data.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const type = String.fromCharCode(h[156] || 48);
    const sizeText = cstr(h.subarray(124, 136)).trim();
    const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN;
    if (!Number.isSafeInteger(size)) throw new Error('a member has an unreadable size');
    const body = data.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      pending = cstr(body);
      continue;
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) pending = m[1];
      continue;
    }
    if (type === 'g') continue;
    const prefix = cstr(h.subarray(345, 500));
    const own = cstr(h.subarray(0, 100));
    const posix = h.subarray(257, 263).toString('latin1') === 'ustar\0';
    const name = pending !== null ? pending : posix && prefix ? `${prefix}/${own}` : own;
    pending = null;
    members.push({ name, type });
  }
  return members;
}

// Refuses an archive that is not a plain `package/` tree. Returns nothing.
function checkMembers(members) {
  if (!members.length) throw new Error('the archive is empty');
  for (const { name, type } of members) {
    if (type !== '0' && type !== '5') throw new Error(`member of kind '${type}' refused: ${JSON.stringify(name).slice(0, 80)}`);
    const clean = name.replace(/\/+$/, '');
    if (/[\\\0-\x1f\x7f]/.test(clean) || clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new Error(`member name refused: ${JSON.stringify(name).slice(0, 80)}`);
    const parts = clean.split('/');
    if (parts[0] !== 'package' || parts.some((p) => p === '..' || p === '.' || p === '')) throw new Error(`member outside package/ refused: ${JSON.stringify(name).slice(0, 80)}`);
    if (type === '0' && parts.length < 2) throw new Error('package is a file, not a directory');
  }
}

// ---- the signer and the gateway ----

function signerToken(socketPath) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/bridge-token', method: 'POST', timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // handled by the status
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // The forwarder is not listening yet (it starts a moment before this) or restarts: the same wait.
    req.on('error', (e) => resolve({ status: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.message === 'timeout' ? 409 : 0, body: {} }));
    req.end();
  });
}

// A usable { token, gatewayUrl }: the signer's 409 (identity not known yet) is waited out, anything else
// that is not a 200 means no gateway call can be made.
async function waitForToken({ socketPath, pollMs, log, wait }) {
  let waited = false;
  for (;;) {
    const r = await signerToken(socketPath);
    if (r.status === 200 && typeof r.body.token === 'string' && typeof r.body.gatewayUrl === 'string') return r.body;
    if (r.status !== 409) throw new Unavailable(`the signer answered ${r.status}${r.body.error ? ` (${String(r.body.error).slice(0, 80)})` : ''}`);
    if (!waited) log('waiting for the gateway to tell this workspace who it belongs to');
    waited = true;
    await wait(pollMs);
  }
}

// https only; plain http for a loopback host only when the caller (a test) says so.
function gatewayBase(value, allowLoopbackHttp) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Unavailable('the gateway URL is not a URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) throw new Unavailable('the gateway URL carries credentials');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowLoopbackHttp && loopback)) throw new Unavailable('the gateway URL is not https');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function validManifest(m) {
  if (!m || typeof m !== 'object' || m.protocol !== PROTOCOL) return `protocol ${m && m.protocol} is not ${PROTOCOL}`;
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return 'version is not a plain version';
  if (typeof m.sha256 !== 'string' || !SHA_RE.test(m.sha256)) return 'sha256 is not 64 hex digits';
  if (!Number.isInteger(m.size) || m.size < 1 || m.size > MAX_SIZE) return `size is not within 1..${MAX_SIZE}`;
  return null;
}

async function gatewayGet(url, token, { timeoutMs }) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

// ---- the cache ----

function readIfFile(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function cachedVersions(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.tgz') && VERSION_RE.test(n.slice(0, -4)))
    .map((n) => {
      const version = n.slice(0, -4);
      let at = 0;
      try {
        at = fs.statSync(path.join(dir, `${version}.sha256`)).mtimeMs;
      } catch {
        // no record: never preferred
      }
      return { version, at };
    })
    .sort((a, b) => b.at - a.at);
}

// The tarball's bytes when they hash to `want`, else null.
function verifiedBytes(dir, version, want) {
  const bytes = readIfFile(path.join(dir, `${version}.tgz`));
  return bytes && bytes.length <= MAX_SIZE && sha256Of(bytes) === want ? bytes : null;
}

function recordedHash(dir, version) {
  const t = readIfFile(path.join(dir, `${version}.sha256`));
  const h = t && t.toString('utf8').trim();
  return h && SHA_RE.test(h) ? h : null;
}

async function download({ base, version, manifest, getToken, dir, timeoutMs }) {
  const token = await getToken();
  const res = await gatewayGet(`${base}/api/bridge/${encodeURIComponent(version)}.tgz`, token.token, { timeoutMs });
  if (res.status !== 200) throw new Unavailable(`the tarball request answered ${res.status}`);
  const part = path.join(dir, `${version}.part`);
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > manifest.size) throw new Unavailable(`the tarball is larger than the manifest's ${manifest.size} bytes`);
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (n !== manifest.size) throw new Unavailable(`the tarball has ${n} bytes, the manifest says ${manifest.size}`);
  if (hash.digest('hex') !== manifest.sha256) throw new Unavailable('the tarball does not hash to the manifest sha256');
  fs.writeFileSync(part, Buffer.concat(chunks), { mode: 0o600 });
  fs.renameSync(part, path.join(dir, `${version}.tgz`));
  fs.writeFileSync(path.join(dir, `${version}.sha256`), `${manifest.sha256}\n`, { mode: 0o600 });
}

// ---- install ----

// Extracts a verified tarball into <dir>/<version>/ (fresh), checks VERSION.json and points `current` at it.
function install({ dir, version, bytes, tarBin }) {
  checkMembers(walkTar(bytes));
  const target = path.join(dir, version);
  const tmp = path.join(dir, `.extract-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const archive = path.join(tmp, 'bridge.tgz');
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out);
  const r = spawnSync(tarBin, ['-xzf', archive, '-C', out, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`tar failed: ${String(r.stderr).slice(0, 200)}`);
  }
  const pkg = path.join(out, 'package');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(pkg, 'VERSION.json'), 'utf8'));
    if (!fs.statSync(path.join(pkg, 'server.mjs')).isFile()) throw new Error('no server.mjs');
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`the package is not a bridge (${e.message})`);
  }
  const got = typeof meta === 'string' ? meta : meta && meta.version;
  if (got !== version || (meta && typeof meta === 'object' && meta.protocol !== undefined && meta.protocol !== PROTOCOL)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`VERSION.json says ${JSON.stringify(got)}, expected ${version}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.renameSync(pkg, path.join(target, 'package'));
  fs.rmSync(tmp, { recursive: true, force: true });
  const link = path.join(dir, `.current-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(version, link);
  fs.renameSync(link, path.join(dir, 'current'));
}

// Keeps the KEEP newest tarballs (and their records and directories); removes the rest, and any part left by a stopped download.
function prune(dir, keepFirst) {
  const all = cachedVersions(dir);
  const keep = new Set([keepFirst, ...all.map((v) => v.version)]);
  const kept = new Set([...keep].slice(0, KEEP));
  for (const { version } of all) {
    if (kept.has(version)) continue;
    for (const f of [`${version}.tgz`, `${version}.sha256`, `${version}.part`]) fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, version), { recursive: true, force: true });
  }
  try {
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.part') || /^\.(extract|current)-/.test(n)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// -> the version now behind `current`. Throws Unavailable when there is no verified bridge to use.
async function fetchBridge({
  home = process.env.HOME,
  socketPath = path.join(home || '', '.liivo', 'sign.sock'),
  pollMs = 2000,
  timeoutMs = 30000,
  allowLoopbackHttp = false,
  tarBin = 'tar',
  log = () => {},
  wait = sleep,
} = {}) {
  if (!home) throw new Error('HOME is not set');
  const dir = path.join(home, '.liivo', 'bridge');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // From the cache: the newest tarball whose recorded hash is still the hash of its bytes.
  const fromCache = (why) => {
    log(`${why}; trying the verified cache`);
    for (const { version } of cachedVersions(dir)) {
      const want = recordedHash(dir, version);
      const bytes = want && verifiedBytes(dir, version, want);
      if (!bytes) continue;
      try {
        install({ dir, version, bytes, tarBin });
        prune(dir, version);
        return version;
      } catch (e) {
        log(`cached ${version} not usable: ${e.message}`);
      }
    }
    throw new Unavailable(`${why}, and there is no verified bridge in the cache`);
  };

  let first;
  try {
    first = await waitForToken({ socketPath, pollMs, log, wait });
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    return fromCache(e.message);
  }
  let manifest;
  let base;
  const getToken = async () => (await waitForToken({ socketPath, pollMs, log, wait }));
  try {
    base = gatewayBase(first.gatewayUrl, allowLoopbackHttp);
    const res = await gatewayGet(`${base}/api/bridge/manifest`, first.token, { timeoutMs });
    if (res.status !== 200) throw new Unavailable(`the gateway answered ${res.status} to the manifest`);
    manifest = await res.json();
    const bad = validManifest(manifest);
    if (bad) throw new Unavailable(`the manifest is refused: ${bad}`);
  } catch (e) {
    return fromCache(e instanceof Unavailable ? e.message : `the gateway is not reachable (${e.cause && e.cause.code ? e.cause.code : e.name})`);
  }

  try {
    let bytes = verifiedBytes(dir, manifest.version, manifest.sha256);
    if (bytes) {
      if (recordedHash(dir, manifest.version) !== manifest.sha256) fs.writeFileSync(path.join(dir, `${manifest.version}.sha256`), `${manifest.sha256}\n`, { mode: 0o600 });
      log(`bridge ${manifest.version} is in the cache`);
    } else {
      log(`downloading bridge ${manifest.version}`);
      await download({ base, version: manifest.version, manifest, getToken, dir, timeoutMs: 120000 });
      bytes = verifiedBytes(dir, manifest.version, manifest.sha256);
      if (!bytes) throw new Unavailable('the stored tarball does not hash to the manifest sha256');
    }
    install({ dir, version: manifest.version, bytes, tarBin });
    prune(dir, manifest.version);
    return manifest.version;
  } catch (e) {
    fs.rmSync(path.join(dir, `${manifest.version}.part`), { force: true });
    return fromCache(e instanceof Unavailable ? e.message : e.name === 'TimeoutError' || e.cause ? `the gateway is not reachable (${(e.cause && e.cause.code) || e.name})` : `the bridge could not be installed: ${e.message}`);
  }
}

async function main() {
  const log = (m) => process.stderr.write(`bridge-fetch: ${m}\n`);
  if (!process.env.HOME) {
    log('HOME is not set');
    process.exit(2);
  }
  try {
    const version = await fetchBridge({ log });
    process.stdout.write(`${version}\n`);
    log(`bridge ${version} in place`);
  } catch (e) {
    log(e instanceof Unavailable ? e.message : `failed: ${e.message}`);
    process.exit(3);
  }
}

if (require.main === module) main();

module.exports = { fetchBridge, walkTar, checkMembers, validManifest, gatewayBase, Unavailable };
