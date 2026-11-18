# Block definition notes

This file records what the OSC catalog entry for this repo is meant to look like.
Nothing here is registered yet. The maker takes the repo contents (`Dockerfile.osc`
is used in preference to `Dockerfile`, see `osaas-maker/src/job.ts`) and the
service definition from the maker order, so the options, memory size and volume
are set when the block is imported, not by a file in this repo.

Expected service id: `eyevinn-liivo-studio-space` (the maker derives it as
`<owner>-<name>` in lower case, see `serviceIdFromOrder` in `osaas-maker`). This
is unverified until the import has run.

## Intended options

Each option maps to one environment variable of the container (`optionMapping`
in the maker order). `osc-entrypoint.sh` reads exactly these names.

| Option | Env var | Type | Required | Sensitive | Notes |
|---|---|---|---|---|---|
| `name` | none | string | yes | no | Instance name, supplied by OSC. |
| `RepoUrl` | `REPO_URL` | string | no | no | Git URL cloned into `/home/coder/project` on first start. Do not embed credentials. |
| `RepoBranch` | `REPO_BRANCH` | string | no | no | Checked out after the clone, created if missing. |
| `AgentUrl` | `CODER_AGENT_URL` | string | yes | no | Public URL of the Coder instance (the `coder-coder` block). |
| `AgentToken` | `CODER_AGENT_TOKEN` | string | yes | yes | Coder agent token. Pass as a `{{secrets.x}}` reference. |
| `PreviewPort` | `PREVIEW_PORT` | number | no | no | Port of the project's dev server. Default 3000. |
| `HandoffKey` | `HANDOFF_KEY` | string | no | yes | Base64 of 32 bytes: the key the edit proxy checks handoff tokens and its session cookie against. Missing or invalid: the proxy answers 503 to every request (fail closed). |
| `GatewayUrl` | `LIIVO_GATEWAY_URL` | string | no | no | Base URL of the Liivo Studio gateway: where a navigation without a session is redirected and where the git credential helper asks for a token. Missing: navigations answer 401 and the helper returns no credentials. |
| `ClaudeCodeOauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` | string | no | yes | The tenant's Claude OAuth token, passed as a `{{secrets.x}}` reference. The literal `unset` (or empty) means the tenant has none. |
| `AnthropicApiKey` | `ANTHROPIC_API_KEY` | string | no | yes | The tenant's Anthropic API key, same rules. |

The option mapping rows for `HandoffKey`, `GatewayUrl`, `ClaudeCodeOauthToken`
and `AnthropicApiKey` are requested from the Supply team in
Eyevinn/agent-team-supply#306. Until they exist the image treats all four as
absent: the edit proxy fails closed (503) and no Claude credential is set.

The LLM proxy is dropped: `PROXY_URL` and `PROXY_TOKEN` are no longer read and
no longer map to `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.

**Claude credentials are readable by code running in the workspace.** The
entrypoint exports `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (each only
when it is non-empty and not the literal `unset`, otherwise it unsets it) into
the environment of the Coder agent, so the terminal, Claude Code and any project
process started from it inherit them. This is the same exposure an Agent Tasks
runner has for the same credential. The entrypoint never prints either value and
removes both from the environment of `.liivo/setup.sh` and `.liivo/start.sh`.

Whether the maker honours a sensitive flag on an option mapping, or whether
sensitivity is set in the catalog entry afterwards, was not verified. Check it
at import time: `AgentToken`, `HandoffKey`, `ClaudeCodeOauthToken` and
`AnthropicApiKey` must not be readable in plain text from the instance
description.

## Variables set by the platform

The orchestrator injects `OSC_HOSTNAME` only (osaas-lib-orchestrator
`containers.ts`, `k8s.ts`). It does not set `PORT`: the main container port is
fixed at 8080 (`name: http`) and the Service targets it. The image therefore sets
`ENV PORT=8080` and the entrypoint defaults `PORT` to 8080. The entrypoint uses
`OSC_HOSTNAME` for `LIIVO_EDIT_URL`.

## Order values to choose at import

- Persistent volume: the architecture note proposes a volume at `/home/coder`.
  Storage is per block (one size for every instance) and is deleted with the
  instance. If no volume is configured, the home directory is the image copy and
  everything is lost on restart.
- Memory: fixed per block, not per instance. Pick one size or import two blocks.
- `public-paths: ^/$` on the block's orchestrator (design D8): `/` is the only
  path that reaches the edit proxy without the OSC login gate, which is where the
  gateway's handoff lands. The edit proxy's own session check is the tenant
  boundary on every path. This is a deploy-manager setting applied after import,
  not part of this repo.

## Known platform limits

- No Docker engine in the workspace and no sudo. Instances cannot run privileged
  containers. Project dependencies (Postgres, Valkey) become separate OSC instances,
  or run as plain processes started through mise or `.liivo/start.sh`.
- Memory is fixed per block and CPU is not limited.
- Storage is lost when the instance is deleted. When an instance is suspended or
  restarted without a persistent volume, the checkout is cloned again from git on
  the next start, so uncommitted work is lost. Commit and push.
- The preview is served on the instance's own OSC hostname
  (`<name>.<serviceId>.auto.<env>.osaas.io`) by the preview forwarder (see
  "Preview forwarder and loopback contract" below). Whether the orchestrator
  needs a listener on `PORT` for the instance to count as ready is unverified.
- Credentials arrive only as environment variables from OSC secrets.

## Preview forwarder and loopback contract

`osc-entrypoint.sh` starts a small forwarder (`forwarder/preview-forwarder.js`,
installed at `/usr/local/lib/liivo/preview-forwarder.js`, `node:http` and
`node:net` only) on `0.0.0.0:$PORT`. It forwards every HTTP request and
WebSocket upgrade to `127.0.0.1:$PREVIEW_PORT`, answers 502 with a short page
when nothing listens on the preview port, and is restarted by a loop in the
entrypoint if it exits (backoff 1s doubling to 30s; exit code 2, a configuration
error, is not retried). It is started with a clean environment (`PATH`, `HOME`,
`PORT`, `PREVIEW_PORT` only), so it never sees tokens. It is not started when
`PORT` (default 8080) equals `PREVIEW_PORT`. The handoff key is the one value it
needs that is secret: the entrypoint pipes it to the forwarder's stdin (the
forwarder reads it once at start), so it is in no environment block.

The forwarder passes `Host` through unchanged and drops `Forwarded`,
`X-Forwarded-*` and `X-Real-IP` from the request before forwarding, because the
caller can set them. The preview app sees no client address headers, must not
trust any such header, and never sees the `__Host-liivo` session cookie (it is
removed from the `Cookie` header; other cookies pass).

- `GET /__liivo/open` answers 302 to `/` (with a session; see below. The gateway
  links here so the browser passes the OSC gate on a gated path before an SPA's
  root loads).
- `GET /__liivo/status` is the status endpoint (see below).
- Every other path under `/__liivo/` is reserved and answers 404 (with a session).

## Edit proxy session (tenant boundary, design D8)

The OSC gate in front of the instance only proves "some signed-in OSC user", and
the cluster-internal address bypasses it. The forwarder is therefore the tenant
boundary: **every** request on **every** address needs its own session, `/` and
WebSocket upgrades included. The session starts only from a gateway handoff.

**Fail closed.** With `HANDOFF_KEY` missing or not 32 bytes of base64, every
request (also status and upgrades) answers 503 with a page saying the project
must be recreated, and the entrypoint and the forwarder log why. Nothing is
served unauthenticated. With `LIIVO_GATEWAY_URL` missing, navigations without a
session answer 401 instead of the redirect, and git credentials are unavailable.

**Token format** (shared with the gateway tickets G4, G6 and G8):
`v1.<payload>.<sig>`. `payload` is base64url of JSON
`{aud, host, tenant, user, instance, exp, nonce}`; `sig` is base64url of
HMAC-SHA256 under the 32 byte `HANDOFF_KEY` over the string `v1.<payload>`.
`aud` is `browser`, `gateway` or `git`; `exp` is Unix seconds; `nonce` is 16
random bytes in base64url. The signature is compared in constant time
(`crypto.timingSafeEqual`). There is no lookup table: the key is derived per
project by the gateway, so a token proves "signed for this project".

**Without a valid session cookie:**

- a navigation (`GET` or `HEAD` with `Accept: text/html`), to any path, answers
  302 to `${LIIVO_GATEWAY_URL}/w/<instance>`;
- every other request, WebSocket upgrades included, answers 401.

**Handoff.** `GET /?__liivo=<token>` (path `/` exactly, one `__liivo`
parameter) is accepted when the token has `aud` `browser`, a `host` equal to the
request's `Host`, an `exp` that has not passed and is at most 60 s ahead, and a
nonce not seen before (kept in memory until the token's `exp`). It answers 302 to
`/__liivo/open` (a gated path, so the OSC gate's own round trip happens after the
handoff) and sets the cookie. A reused, expired, foreign-host, wrong-audience or
badly signed token answers 401. The token is never forwarded to the preview and
never logged.

**Session cookie:** `__Host-liivo=s1.<payload>.<sig>; Max-Age=43200; Path=/;
HttpOnly; Secure; SameSite=Lax` (no `Domain`, so it is host-only). `payload` is
base64url of `{tenant, user, instance, exp}` (the claims of the handoff token,
`exp` 12 hours ahead) and `sig` is HMAC-SHA256 under `HANDOFF_KEY` over
`s1.<payload>`. The `s1` prefix keeps a token from ever being a valid cookie and
the other way round. A request that can change state (anything but `GET` or
`HEAD`) or open a WebSocket and carries an `Origin` other than the request's own
host is refused with 401 even with a valid cookie, because a sibling
`*.osaas.io` app is the same site and `SameSite` does not stop it.

**Status.** `GET /__liivo/status` with `Authorization: Bearer <token aud=gateway>`
(not single use, `exp` at most 60 s ahead) answers 200 JSON
`{"checkout": bool, "clean": bool, "unpushed": number, "branch": string|null}`:
a git checkout exists in the project directory; the working tree has no
uncommitted or untracked files (with no checkout: the directory is empty);
commits not on the upstream branch (or on no remote when the branch has no
upstream); the current branch. Without a valid bearer: 401. If git itself fails:
500, never "clean".

**Git credential helper.** The image sets
`credential.https://github.com.helper` (system config) to
`forwarder/git-credential-liivo.js`. For `https://github.com` it asks the
forwarder, over a unix socket (`$HOME/.liivo/sign.sock`, mode 0600, so the key
never leaves the forwarder), for an `aud` `git` token (60 s, `tenant`, `user`,
`instance` as last learned from a verified handoff or status token and kept in
`$HOME/.liivo/identity.json`), calls `POST ${LIIVO_GATEWAY_URL}/api/git-token`
with `Authorization: Bearer <git token>` and returns the `token` it receives as
the password (user name `x-access-token`). If the gateway refuses, is
unreachable, or the tenant is not known yet, it returns nothing, git goes on
unauthenticated (public repositories still clone) and the helper writes one line
to stderr naming the cause. The token is never in a URL, argument, file or
environment variable. A private repository cannot be cloned by the first start
of a new instance, because the tenant is learned from the first handoff or status
call; the gateway's status poll teaches it, and a later `git pull` works.

**Contract for a project's dev server:** bind to `127.0.0.1:$PREVIEW_PORT`, not
to `0.0.0.0`. The entrypoint exports `HOST=127.0.0.1` for `.liivo/setup.sh` and
`.liivo/start.sh`, which many tools honour. Flags for common servers:

- Vite: `vite --host 127.0.0.1 --port "$PREVIEW_PORT"`
- Next.js: `next dev -H 127.0.0.1 -p "$PREVIEW_PORT"`

The forwarder must be the only listener on a non-loopback address in the
instance. Check with `ss -ltn` (or `/proc/net/tcp`).

The entrypoint also sets `CODER_AGENT_DEVCONTAINERS_ENABLE=false`: the instance
has no Docker engine, and the agent's devcontainer detection otherwise logs
`docker: command not found` in a loop.

Tests: `node --test 'forwarder/*.test.js' 'test/*.test.js'` (the second pattern
runs the real `osc-entrypoint.sh` against a stub `coder`) and
`shellcheck osc-entrypoint.sh`.

## Security notes

- The entrypoint removes `CODER_AGENT_TOKEN`, `CODER_AGENT_URL` and
  `CODER_AGENT_AUTH` from the environment of `.liivo/setup.sh` and
  `.liivo/start.sh`, so the hooks do not inherit them. This is hygiene, not
  isolation: the hooks run as the same uid (1000) as the Coder agent, so a hook
  can read the agent's `/proc/<pid>/environ` and get the token. The image has no
  sudo and runs as uid 1000, so the entrypoint cannot run the hooks as another
  uid. The token only grants access to this one workspace's agent endpoints, and
  the hooks are the workspace owner's own repo code. Writing the token to a file
  would not help, since the same uid can read it too.
- Do not embed credentials in `RepoUrl`. The entrypoint masks the userinfo part
  when it logs the URL, but the full URL is still passed to `git clone`, stored
  in the checkout's `.git/config` as the `origin` remote and visible in the
  instance options. Private repositories use the git credential helper above.
- `HANDOFF_KEY` is removed from the environment of the Coder agent and of every
  process it starts, and reaches the forwarder only on stdin. It is still in the
  environment block of the container's first process (PID 1, tini), which code
  running as the same uid can read through `/proc/1/environ`, so this is hygiene
  and not isolation either. What that code could do with the key it can already
  do (open its own workspace, ask for its own repository token); other
  workspaces use other keys, and members of the same tenant who can reveal
  service secrets can read the key (the OSC trust model for any instance).
