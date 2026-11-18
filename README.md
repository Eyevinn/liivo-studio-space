# liivo-studio-space

[![Badge OSC](https://img.shields.io/badge/Evaluate-24243B?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8%2BCjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM%2BCjwvc3ZnPgo%3D)](https://app.osaas.io/browse/eyevinn-liivo-studio-space?create=1&utm_source=github&utm_medium=readme&utm_campaign=liivo-studio-space)

A project workspace for Liivo Studio, packaged as a block for Eyevinn Open Source Cloud (OSC). One instance of this block is one workspace for one Studio project. It runs the Coder agent, not the Coder server.

**Status: not yet registered in the OSC catalog.** The image builds from `Dockerfile.osc`, but nobody has imported the repo into any OSC environment. The badge above points at the service id the maker is expected to assign (`eyevinn-liivo-studio-space`). That id is unverified until the first import, and the link will not work before then.

## How it fits

- The Coder server runs as the `coder-coder` block in a Studio tenant on OSC.
- Each Studio project workspace is an instance of this block. A Coder template creates it through `terraform-provider-osc` and passes the Coder agent URL and token as instance options.
- On start the container clones the project repository, runs the project's `.liivo/setup.sh` once and `.liivo/start.sh` on every start, and then runs `coder agent`, which connects out to the Coder server.
- The preview is served on the instance's own OSC hostname.

The workspace image is adapted from `Eyevinn/liivo-studio` `images/workspace`. It has no Docker engine and no sudo, because OSC instances cannot run privileged containers.

## What is in the image

Ubuntu 24.04, a non-root user (uid 1000), git, build tools, python3, ripgrep, jq, mise with Node 22 as the default, Claude Code, tini, and the `coder` binary copied from `ghcr.io/coder/coder:v2.38.10`. Bundling the binary keeps it at the same version as the server and avoids downloading it from the Coder instance through the OSC login gate.

## Options

| Environment variable | Required | Purpose |
|---|---|---|
| `CODER_AGENT_URL` | yes | Public URL of the Coder instance |
| `CODER_AGENT_TOKEN` | yes | Coder agent token, pass as an OSC secret |
| `REPO_URL` | no | Git URL to clone into `/home/coder/project` on first start |
| `REPO_BRANCH` | no | Branch to check out or create |
| `PREVIEW_PORT` | no | Dev server port, default 3000 |
| `PROXY_URL`, `PROXY_TOKEN` | no | Placeholders for the Claude LLM proxy, not yet wired |

The entrypoint exits with a clear message if `CODER_AGENT_URL` or `CODER_AGENT_TOKEN` is missing. It never prints secret values. See [docs/block.md](docs/block.md) for the intended catalog options and the platform limits.

## Build

```bash
docker build --platform linux/amd64 -f Dockerfile.osc -t liivo-studio-space .
docker run --rm --platform linux/amd64 --entrypoint coder liivo-studio-space version
```

## License

MIT, see [LICENSE](LICENSE).
