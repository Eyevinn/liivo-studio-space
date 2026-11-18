'use strict';
// Handoff tokens and session cookies for the Liivo Studio edit proxy.
// node:crypto only. See docs/block.md "Edit proxy session" for the format.
//
//   token  = "v1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(key, "v1." + b64url(JSON payload)))
//   cookie = "s1." + b64url(JSON session) + "." + b64url(HMAC-SHA256(key, "s1." + b64url(JSON session)))
//
// The two formats have different prefixes inside the signed string, so a token
// is never a valid cookie and a cookie is never a valid token.
const crypto = require('node:crypto');

const COOKIE_NAME = '__Host-liivo';
const COOKIE_TTL_SECONDS = 12 * 60 * 60;
const MAX_TOKEN_AHEAD_SECONDS = 60;
const MAX_VALUE_LENGTH = 4096;
const AUDIENCES = new Set(['browser', 'gateway', 'git']);

// HANDOFF_KEY: base64 of exactly 32 bytes. Returns a Buffer, or null when the
// value is absent or invalid (the caller then fails closed).
function parseKey(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const key = Buffer.from(v, 'base64');
  return key.length === 32 ? key : null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(key, prefix, payloadObj) {
  const body = `${prefix}.${b64url(JSON.stringify(payloadObj))}`;
  const sig = crypto.createHmac('sha256', key).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

// Verifies the signature in constant time and returns the parsed payload object,
// or null. No claim is checked here.
function open(key, prefix, value) {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = crypto.createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  // Length is not secret (always 32 for a well-formed signature).
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const obj = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Verifies a handoff token: signature, audience, expiry (not passed, at most 60 s
// ahead). The host and nonce checks belong to the caller. Returns
// { ok: true, claims } or { ok: false, reason }.
function verifyToken(key, token, audience, nowSeconds) {
  const p = open(key, 'v1', token);
  if (!p) return { ok: false, reason: 'signature' };
  if (!AUDIENCES.has(p.aud) || p.aud !== audience) return { ok: false, reason: 'audience' };
  if (!Number.isInteger(p.exp)) return { ok: false, reason: 'exp' };
  if (p.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  if (p.exp > nowSeconds + MAX_TOKEN_AHEAD_SECONDS) return { ok: false, reason: 'too-far-ahead' };
  return {
    ok: true,
    claims: {
      aud: p.aud,
      host: str(p.host),
      tenant: str(p.tenant),
      user: str(p.user),
      instance: str(p.instance),
      exp: p.exp,
      nonce: str(p.nonce),
    },
  };
}

function signToken(key, claims) {
  return sign(key, 'v1', { ...claims, nonce: 'nonce' in claims ? claims.nonce : crypto.randomBytes(16).toString('base64url') });
}

// Session cookie value: who the handoff was for and when the session ends.
function signSession(key, { tenant, user, instance }, nowSeconds) {
  return sign(key, 's1', { tenant, user, instance, exp: nowSeconds + COOKIE_TTL_SECONDS });
}

function verifySession(key, value, nowSeconds) {
  const p = open(key, 's1', value);
  if (!p || !Number.isInteger(p.exp) || p.exp <= nowSeconds) return null;
  return { tenant: str(p.tenant), user: str(p.user), instance: str(p.instance), exp: p.exp };
}

function setCookieHeader(value) {
  return `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(header) {
  const out = [];
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

function sessionFromCookieHeader(key, header, nowSeconds) {
  for (const [name, value] of parseCookies(header)) {
    if (name === COOKIE_NAME) {
      const s = verifySession(key, value, nowSeconds);
      if (s) return s;
    }
  }
  return null;
}

// The Cookie header without the edit proxy's own cookie, or null when nothing
// else is left. The project never sees the session.
function stripSessionCookie(header) {
  if (typeof header !== 'string') return null;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.split('=')[0].trim() !== COOKIE_NAME);
  return kept.length ? kept.join('; ') : null;
}

// Remembers nonces until the token's exp, so a handoff token works once.
function createNonceStore() {
  const seen = new Map();
  return {
    // Returns false when the nonce was already used.
    use(nonce, exp, nowSeconds) {
      for (const [n, e] of seen) if (e <= nowSeconds) seen.delete(n);
      if (seen.has(nonce)) return false;
      seen.set(nonce, exp);
      return true;
    },
    size: () => seen.size,
  };
}

module.exports = {
  COOKIE_NAME,
  COOKIE_TTL_SECONDS,
  parseKey,
  signToken,
  verifyToken,
  signSession,
  verifySession,
  setCookieHeader,
  sessionFromCookieHeader,
  stripSessionCookie,
  createNonceStore,
};
