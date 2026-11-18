'use strict';
// Shell test of osc-entrypoint.sh: it runs the real script against a stub `coder`
// that records the environment the coder agent (and so every project process
// started from it) would inherit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ENTRYPOINT = path.join(__dirname, '..', 'osc-entrypoint.sh');
const KEY = crypto.randomBytes(32).toString('base64');

function run(extraEnv) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lse-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const out = path.join(dir, 'agent-env');
  fs.writeFileSync(path.join(bin, 'coder'), `#!/bin/bash\nenv > "${out}"\n`, { mode: 0o755 });
  const res = spawnSync('bash', [ENTRYPOINT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      CODER_AGENT_URL: 'https://coder.example.test',
      CODER_AGENT_TOKEN: 'agent-token-value',
      PORT: '8080',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  const env = {};
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { env, log: `${res.stdout}${res.stderr}`, status: res.status };
}

test('each Claude variable is exported when it holds a real value', () => {
  const r = run({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1', ANTHROPIC_API_KEY: 'api-secret-2' });
  assert.strictEqual(r.status, 0, r.log);
  assert.strictEqual(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-secret-1');
  assert.strictEqual(r.env.ANTHROPIC_API_KEY, 'api-secret-2');
  assert.ok(!r.log.includes('oauth-secret-1') && !r.log.includes('api-secret-2'), 'values are never logged');
});

test('only the OAuth token is exported when the API key is the literal unset, and the other way round', () => {
  let r = run({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1', ANTHROPIC_API_KEY: 'unset' });
  assert.strictEqual(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-secret-1');
  assert.ok(!('ANTHROPIC_API_KEY' in r.env));
  r = run({ CLAUDE_CODE_OAUTH_TOKEN: 'unset', ANTHROPIC_API_KEY: 'api-secret-2' });
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in r.env));
  assert.strictEqual(r.env.ANTHROPIC_API_KEY, 'api-secret-2');
});

test('both variables are unset when empty, the literal unset, or not given', () => {
  for (const env of [{}, { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' }, { CLAUDE_CODE_OAUTH_TOKEN: 'unset', ANTHROPIC_API_KEY: 'unset' }]) {
    const r = run(env);
    assert.strictEqual(r.status, 0, r.log);
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in r.env), JSON.stringify(env));
    assert.ok(!('ANTHROPIC_API_KEY' in r.env), JSON.stringify(env));
  }
});

test('the LLM proxy options no longer map to ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN', () => {
  const r = run({ PROXY_URL: 'https://proxy.example.test', PROXY_TOKEN: 'proxy-token' });
  assert.ok(!('ANTHROPIC_BASE_URL' in r.env));
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in r.env));
});

test('HANDOFF_KEY is not in the environment of the coder agent, valid or not', () => {
  for (const key of [KEY, 'not-a-key', '']) {
    const r = run({ HANDOFF_KEY: key });
    assert.strictEqual(r.status, 0, r.log);
    assert.ok(!('HANDOFF_KEY' in r.env));
    if (key) assert.ok(!r.log.includes(key));
  }
});

test('the entrypoint logs why a missing or malformed HANDOFF_KEY fails closed, and a valid one logs no warning', () => {
  assert.match(run({}).log, /HANDOFF_KEY is not set .* answers 503/);
  assert.match(run({ HANDOFF_KEY: 'not-a-key' }).log, /HANDOFF_KEY is not 32 bytes of base64.* answers 503/);
  assert.match(run({ HANDOFF_KEY: crypto.randomBytes(31).toString('base64') }).log, /not 32 bytes/);
  assert.doesNotMatch(run({ HANDOFF_KEY: KEY }).log, /HANDOFF_KEY/);
});
