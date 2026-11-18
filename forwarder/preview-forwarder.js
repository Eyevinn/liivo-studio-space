'use strict';
// Edit proxy and preview forwarder for the Liivo Studio workspace block. Listens
// on 0.0.0.0:PORT (the only non-loopback listener in the instance) and forwards
// HTTP requests and WebSocket upgrades to the project's preview on
// 127.0.0.1:PREVIEW_PORT, but only for a caller with this proxy's own session
// (design D8): every request, `/` and upgrades included, on every address.
// A session starts only from a gateway handoff token (forwarder/auth.js).
// node:http, node:net, node:crypto, node:fs only, no dependencies.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth.js');
const { workspaceStatus } = require('./workspace-status.js');

const RESERVED_PREFIX = '/__liivo/';
const OPEN_PATH = '/__liivo/open';
const STATUS_PATH = '/__liivo/status';
const HANDOFF_PARAM = '__liivo';

const PAGE_503 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Project must be recreated</title></head>' +
  '<body><h1>Project must be recreated</h1><p>This workspace has no valid access key and refuses all requests. ' +
  'Recreate the project.</p></body></html>\n';

const PAGE_401 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sign in required</title></head>' +
  '<body><h1>Sign in required</h1><p>Open this project from Liivo Studio.</p></body></html>\n';

const PAGE_502 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview not running</title></head>' +
  "<body><h1>Preview not running</h1><p>The project's preview is not running.</p></body></html>\n";

// Normalised path of a request target, for the /__liivo/ checks only (the
// forwarded target is never rewritten). Handles absolute-form targets
// (`GET http://x/__liivo/..`), dot segments, percent-encoding, repeated slashes
// and case.
function pathOf(url) {
  let p;
  try {
    // Leading slashes are collapsed first: `//host/p` would otherwise parse as
    // a protocol-relative URL and hide the path.
    p = new URL(url.replace(/^\/{2,}/, '/'), 'http://x').pathname;
  } catch {
    p = url;
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the undecoded path
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

function isReserved(url) {
  const p = pathOf(url);
  return p === '/__liivo' || p.startsWith(RESERVED_PREFIX);
}

// Normalised path plus query parameters of a request target.
function targetOf(url) {
  try {
    const u = new URL(url.replace(/^\/{2,}/, '/'), 'http://x');
    return { path: pathOf(url), params: u.searchParams };
  } catch {
    return { path: pathOf(url), params: new URLSearchParams() };
  }
}

// LIIVO_GATEWAY_URL: an http(s) URL without credentials, no trailing slash.
// Returns '' for anything else (navigations then answer 401 instead of 302).
function parseGatewayUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

// Headers that describe the client or the hop are set by the ingress, not by the
// caller, and this proxy never trusts them: they are dropped before forwarding.
// `Host` is passed on unchanged and is used for no decision except the
// handoff's host binding. The session cookie is removed from the Cookie header.
function isUntrustedHeader(name) {
  const n = name.toLowerCase();
  return n === 'forwarded' || n === 'x-real-ip' || n.startsWith('x-forwarded-');
}

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isUntrustedHeader(name)) continue;
    if (name.toLowerCase() === 'cookie') {
      const kept = auth.stripSessionCookie(value);
      if (kept) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

function isNavigation(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(req.headers.accept || '');
}

// A browser request from another origin (a sibling *.osaas.io app is the same
// site, so SameSite does not stop it) must not ride the session cookie when it
// can change state or open a WebSocket.
function crossOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase();
  } catch {
    return true;
  }
}

function bearer(req) {
  const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

function createForwarder({
  previewPort,
  upstreamHost = '127.0.0.1',
  handoffKey = null,
  gatewayUrl = '',
  instance = '',
  projectDir = '',
  identityFile = '',
  now = () => Math.floor(Date.now() / 1000),
}) {
  const nonces = auth.createNonceStore();
  // Who the gateway said this workspace belongs to, learned from verified
  // tokens only. Not secret. Kept on disk so a restart remembers it.
  let identity = { tenant: '', user: '', instance: instance || '' };
  if (identityFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (saved && typeof saved.tenant === 'string' && typeof saved.instance === 'string') {
        identity = { tenant: saved.tenant, user: String(saved.user || ''), instance: saved.instance };
      }
    } catch {
      // none saved yet
    }
  }
  // Once the identity has been learned from a verified token, a token naming
  // another instance is refused (defence in depth: the key is per project).
  // Before the first handoff nothing is known, so the first one teaches it.
  function instanceMismatch(claims) {
    return Boolean(identity.tenant) && claims.instance !== identity.instance;
  }
  function learn(claims) {
    if (!claims.tenant || !claims.instance) return;
    if (identity.tenant === claims.tenant && identity.instance === claims.instance && (!claims.user || identity.user === claims.user)) return;
    identity = { tenant: claims.tenant, user: claims.user || identity.user, instance: claims.instance };
    if (identityFile) {
      try {
        fs.writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 });
      } catch {
        // best effort
      }
    }
  }

  function text(res, status, type, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  }

  // No valid session: a navigation is sent to the gateway, everything else is 401.
  function deny(req, res) {
    const inst = identity.instance || instance;
    if (isNavigation(req) && gatewayUrl && inst) {
      res.writeHead(302, {
        Location: `${gatewayUrl}/w/${encodeURIComponent(inst)}`,
        'Content-Length': '0',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    text(res, 401, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : PAGE_401);
  }

  function handoff(req, res, tokens) {
    const refuse = () => text(res, 401, 'text/plain', 'Unauthorized\n', { 'Referrer-Policy': 'no-referrer' });
    if (tokens.length !== 1) return refuse();
    const t = now();
    const v = auth.verifyToken(handoffKey, tokens[0], 'browser', t);
    if (!v.ok) return refuse();
    const host = String(req.headers.host || '').toLowerCase();
    if (!host || v.claims.host.toLowerCase() !== host) return refuse();
    if (instanceMismatch(v.claims)) return refuse();
    if (!v.claims.nonce || !nonces.use(v.claims.nonce, v.claims.exp, t)) return refuse();
    learn(v.claims);
    res.writeHead(302, {
      Location: OPEN_PATH,
      'Set-Cookie': auth.setCookieHeader(auth.signSession(handoffKey, v.claims, t)),
      'Content-Length': '0',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  async function status(req, res) {
    const v = auth.verifyToken(handoffKey, bearer(req), 'gateway', now());
    if (!v.ok) {
      return text(res, 401, 'application/json', '{"error":"unauthorized"}\n', { 'WWW-Authenticate': 'Bearer' });
    }
    if (instanceMismatch(v.claims)) {
      return text(res, 401, 'application/json', '{"error":"unauthorized"}\n', { 'WWW-Authenticate': 'Bearer' });
    }
    learn(v.claims);
    if (req.method !== 'GET') {
      return text(res, 405, 'application/json', '{"error":"method not allowed"}\n', { Allow: 'GET' });
    }
    try {
      const st = await workspaceStatus(projectDir);
      text(res, 200, 'application/json', `${JSON.stringify(st)}\n`);
    } catch (e) {
      text(res, 500, 'application/json', `${JSON.stringify({ error: e.message })}\n`);
    }
  }

  const server = http.createServer((req, res) => {
    if (!handoffKey) {
      // Fail closed: nothing is served without a key to check sessions against.
      req.resume();
      text(res, 503, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : PAGE_503);
      return;
    }
    const target = targetOf(req.url);
    if (target.path === STATUS_PATH) {
      req.resume();
      status(req, res);
      return;
    }
    if (req.method === 'GET' && target.path === '/' && target.params.has(HANDOFF_PARAM)) {
      req.resume();
      handoff(req, res, target.params.getAll(HANDOFF_PARAM));
      return;
    }
    if (!auth.sessionFromCookieHeader(handoffKey, req.headers.cookie, now())) {
      req.resume();
      deny(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossOrigin(req)) {
      req.resume();
      text(res, 401, 'text/plain', 'Unauthorized\n');
      return;
    }
    if (target.path === OPEN_PATH) {
      req.resume();
      res.writeHead(302, { Location: '/', 'Content-Length': '0', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (isReserved(req.url)) {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '10' });
      res.end('Not found\n');
      return;
    }
    const upstream = http.request(
      {
        host: upstreamHost,
        port: previewPort,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers),
        agent: false,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(PAGE_502),
      });
      res.end(PAGE_502);
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reply = (line) => socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!handoffKey) {
      reply('503 Service Unavailable');
      return;
    }
    if (!auth.sessionFromCookieHeader(handoffKey, req.headers.cookie, now()) || crossOrigin(req)) {
      reply('401 Unauthorized');
      return;
    }
    if (isReserved(req.url)) {
      reply('404 Not Found');
      return;
    }
    const upstream = net.connect(previewPort, upstreamHost);
    let established = false;
    upstream.on('error', () => {
      // Never write a 502 page into a stream that is already past the handshake.
      if (established) {
        socket.destroy();
      } else if (socket.writable) {
        socket.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(PAGE_502)}\r\n\r\n${PAGE_502}`
        );
      } else {
        socket.destroy();
      }
    });
    upstream.on('connect', () => {
      established = true;
      let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        if (isUntrustedHeader(name)) continue;
        if (name.toLowerCase() === 'cookie') {
          value = auth.stripSessionCookie(value);
          if (!value) continue;
        }
        rawHead += `${name}: ${value}\r\n`;
      }
      upstream.write(`${rawHead}\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    // Half-close first so data still in flight is flushed, then destroy.
    upstream.on('end', () => socket.end());
    socket.on('end', () => upstream.end());
    upstream.on('close', () => setTimeout(() => socket.destroy(), 1000).unref());
    socket.on('close', () => setTimeout(() => upstream.destroy(), 1000).unref());
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  // Signs an `aud` git token for the git credential helper. Served only on a
  // unix socket (mode 0600) in the home directory: the helper runs inside the
  // workspace, and the key itself never leaves this process.
  server.signer = http.createServer((req, res) => {
    req.resume();
    const inst = identity.instance || instance;
    const refuse = (status, msg) => text(res, status, 'application/json', `${JSON.stringify({ error: msg })}\n`);
    if (req.method !== 'POST' || req.url !== '/git-token') return refuse(404, 'not found');
    if (!handoffKey) return refuse(503, 'HANDOFF_KEY is not set');
    if (!gatewayUrl) return refuse(503, 'LIIVO_GATEWAY_URL is not set');
    if (!identity.tenant || !inst) {
      return refuse(409, 'tenant not known yet: no handoff or status call has reached this workspace');
    }
    const token = auth.signToken(handoffKey, {
      aud: 'git',
      host: '',
      tenant: identity.tenant,
      user: identity.user,
      instance: inst,
      exp: now() + 60,
    });
    text(res, 200, 'application/json', `${JSON.stringify({ token, gatewayUrl })}\n`);
  });

  return server;
}

function listenOnSocket(server, socketPath) {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // none left over
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
}

function parsePort(name, value) {
  if (!/^[0-9]+$/.test(value || '')) throw new Error(`${name} must be a number, got '${value}'`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`${name} out of range: ${value}`);
  return n;
}

// The key arrives on stdin, never in the environment: the entrypoint starts this
// process with `env -i`, and an environment variable would also show up in
// /proc/<pid>/environ and in anything that inherits it.
function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    setTimeout(done, timeoutMs).unref();
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  const port = parsePort('PORT', process.env.PORT);
  const previewPort = parsePort('PREVIEW_PORT', process.env.PREVIEW_PORT || '3000');
  const handoffKey = auth.parseKey(await readStdin());
  const rawGateway = process.env.LIIVO_GATEWAY_URL || '';
  const gatewayUrl = parseGatewayUrl(rawGateway);
  const home = process.env.HOME || '/home/coder';
  if (!handoffKey) {
    console.error(
      'edit-proxy: HANDOFF_KEY is missing or not 32 bytes of base64: refusing every request (503). Recreate the project.'
    );
  }
  if (rawGateway && !gatewayUrl) console.error('edit-proxy: LIIVO_GATEWAY_URL is not a valid http(s) URL, ignored');
  if (!rawGateway) {
    console.error('edit-proxy: LIIVO_GATEWAY_URL is not set: navigations without a session answer 401, git credentials are unavailable');
  }
  // An unexpected error must never take the forwarder down.
  process.on('uncaughtException', (e) => console.error(`preview-forwarder: ${e.message}`));
  const server = createForwarder({
    previewPort,
    handoffKey,
    gatewayUrl,
    instance: process.env.LIIVO_INSTANCE || '',
    projectDir: process.env.PROJECT_DIR || path.join(home, 'project'),
    identityFile: path.join(home, '.liivo', 'identity.json'),
  });
  try {
    await listenOnSocket(server.signer, process.env.LIIVO_SOCKET || path.join(home, '.liivo', 'sign.sock'));
  } catch (e) {
    // The proxy still serves; only the git credential helper is unavailable.
    console.error(`edit-proxy: git signing socket not available: ${e.message}`);
  }
  server.listen(port, '0.0.0.0', () => {
    console.error(`preview-forwarder: 0.0.0.0:${port} -> 127.0.0.1:${previewPort}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`preview-forwarder: ${e.message}`);
    process.exit(2);
  });
}

module.exports = { createForwarder, parseGatewayUrl, listenOnSocket };
