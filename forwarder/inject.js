'use strict';
// What the edit proxy changes in the previewed project's HTML pages (design D27): one
// <script src="/__liivo/client.js" defer> tag, which loads the bridge's toolbar and chat. The
// functions here decide which request is a page navigation, which headers the upstream request
// must not carry, whether an answer may be touched, where the tag goes and which CSP nonce it
// copies. node:* only.

const CLIENT_SRC = '/__liivo/client.js';
const NONCE_RE = /^[A-Za-z0-9+/=_-]{8,200}$/;

// A browser navigation. Sec-Fetch-Dest decides when the browser sends it (`document`; an iframe or a
// fetch() is not one). Without it (an old browser, a test) only a GET or HEAD asking for text/html is.
function isNavigationRequest(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest === 'string' && dest !== '') return dest === 'document';
  return (req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(req.headers.accept || '');
}

const CONDITIONAL = new Set(['range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since']);

// The request headers for the upstream of a navigation: no Range and no conditional header (a 206 or a
// 304 cannot carry the tag), no compression (the tag is inserted into plain bytes).
function navigationHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CONDITIONAL.has(name.toLowerCase()) || name.toLowerCase() === 'accept-encoding') continue;
    out[name] = value;
  }
  out['accept-encoding'] = 'identity';
  return out;
}

// May this upstream answer be buffered and tagged? Only a body of text/html that is neither partial nor
// compressed. HEAD, 1xx, 204 and 304 carry no body.
function isTaggable(method, statusCode, headers) {
  if (method === 'HEAD' || statusCode < 200 || statusCode === 204 || statusCode === 206 || statusCode === 304) return false;
  const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return false;
  return /^\s*text\/html\b/i.test(String(headers['content-type'] || ''));
}

// A nonce from a Content-Security-Policy header, else from a <meta http-equiv> in the page, else ''.
// Only a plain nonce value is copied: it ends up inside an attribute.
function findNonce(cspHeader, html) {
  const fromPolicy = (text) => {
    const m = /'nonce-([^'\s]+)'/i.exec(text || '');
    return m && NONCE_RE.test(m[1]) ? m[1] : '';
  };
  const header = fromPolicy([].concat(cspHeader || []).join(';'));
  if (header) return header;
  const meta = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i.exec(html);
  if (!meta) return '';
  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(meta[0]);
  return content ? fromPolicy(content[1] ?? content[2]) : '';
}

function tagFor(nonce) {
  return `<script src="${CLIENT_SRC}" defer${nonce ? ` nonce="${nonce}"` : ''}></script>`;
}

// Inserts the tag before the last </body> (at the end when there is none). The bytes are searched as
// latin1, which keeps every byte its own character, so the page's own encoding is never touched.
// A page that already has the tag is returned as it is.
function insertTag(buf, nonce = '') {
  const text = buf.toString('latin1');
  if (text.includes(CLIENT_SRC)) return buf;
  const tag = Buffer.from(tagFor(nonce), 'latin1');
  let at = -1;
  for (const m of text.matchAll(/<\/body\s*>/gi)) at = m.index;
  if (at < 0) return Buffer.concat([buf, tag]);
  return Buffer.concat([buf.subarray(0, at), tag, buf.subarray(at)]);
}

// The headers of a tagged answer, as the upstream sent them (rawHeaders keeps a repeated header, Set-Cookie
// included, as separate entries) less what no longer describes the body, with no-store.
const DROPPED = new Set(['content-length', 'etag', 'last-modified', 'cache-control', 'transfer-encoding']);
function taggedHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (!DROPPED.has(rawHeaders[i].toLowerCase())) out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  out.push('Cache-Control', 'no-store');
  return out;
}

// The script the page gets while the bridge is not answering: a small pill, health polled from 2 s up to
// 30 s, one reload when the bridge answers, and after five minutes the plain sentence that the preview
// works without the chat. It never runs on a page that already has the real toolbar.
const PLACEHOLDER_CLIENT = `(function () {
  if (window.__liivoPlaceholder || document.getElementById('liivo-root')) return;
  window.__liivoPlaceholder = true;
  var started = Date.now();
  var delay = 2000;
  var pill = document.createElement('div');
  pill.setAttribute('data-liivo-placeholder', '');
  pill.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 12px;border-radius:999px;background:#111;color:#fff;font:13px system-ui,sans-serif;opacity:.9;pointer-events:none';
  pill.textContent = 'Chatten startar\\u2026';
  function mount() { (document.body || document.documentElement).appendChild(pill); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  function poll() {
    fetch('/__liivo/health', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (r.ok) { location.reload(); return; }
      next();
    }, next);
  }
  function next() {
    if (Date.now() - started > 300000) { pill.textContent = 'Chatten \\u00e4r inte tillg\\u00e4nglig just nu. F\\u00f6rhandsvisningen fungerar \\u00e4nd\\u00e5.'; return; }
    delay = Math.min(delay * 1.5, 30000);
    setTimeout(poll, delay);
  }
  setTimeout(poll, delay);
})();
`;

module.exports = {
  CLIENT_SRC,
  PLACEHOLDER_CLIENT,
  isNavigationRequest,
  navigationHeaders,
  isTaggable,
  findNonce,
  tagFor,
  insertTag,
  taggedHeaders,
};
