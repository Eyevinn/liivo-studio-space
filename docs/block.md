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
| `ProxyUrl` | `PROXY_URL` | string | no | no | Placeholder, not yet wired: base URL of the Studio LLM proxy. Becomes `ANTHROPIC_BASE_URL`. |
| `ProxyToken` | `PROXY_TOKEN` | string | no | yes | Placeholder, not yet wired: per-workspace proxy token. Becomes `ANTHROPIC_AUTH_TOKEN`. |

`ProxyUrl` and `ProxyToken` are only used when both are set. The Studio LLM proxy
does not exist yet, so leave them out of the first import or keep them optional.

Whether the maker honours a sensitive flag on an option mapping, or whether
sensitivity is set in the catalog entry afterwards, was not verified. Check it
at import time: `AgentToken` and `ProxyToken` must not be readable in plain text
from the instance description.

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
- `public-paths: ^/` on the block's orchestrator, so the OSC login gate does not
  front previews (see the architecture note, section 3.2). This is a deploy-manager
  setting applied after import, not part of this repo.

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
`PORT` (default 8080) equals `PREVIEW_PORT`.

The forwarder passes `Host` and any `X-Forwarded-*` headers through unchanged.
The preview app must not trust them, and the preview is not an authentication
boundary: the W2 edit proxy is the tenant boundary.

- `GET /__liivo/open` answers 302 to `/` (the gateway links here so the browser
  passes the OSC gate on a gated path before an SPA's root loads).
- Every other path under `/__liivo/` is reserved and answers 404.

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

Tests: `node --test 'forwarder/*.test.js'`.

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
  instance options. Private repositories should use a git credential helper or
  `GIT_ASKPASS` instead; that is not implemented yet and is left to a later
  change.
