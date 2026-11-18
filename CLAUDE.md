# liivo-studio-space

OSC block for a Liivo Studio project workspace: Ubuntu image running the Coder agent, one instance per workspace. Design: `communications/liivo-studio-architecture.md` in `Eyevinn/agent-team-osc-dev`.

## Rules

- `Dockerfile.osc` is what the OSC maker builds (it prefers it over `Dockerfile`). Keep the Coder image tag in sync with the `coder-coder` block (`eyevinn-osaas/coder` `Dockerfile.osc`).
- No Docker engine, no sudo, no privileged anything: OSC instances run unprivileged.
- Credentials arrive only as environment variables from OSC secrets. Never bake them into the image and never print them.
- `osc-entrypoint.sh` must fail loudly if `CODER_AGENT_URL` or `CODER_AGENT_TOKEN` is missing.
- Options, memory and volume are defined in the maker order, not in this repo. Keep `docs/block.md` in step with the entrypoint's variable names.
- GitHub Actions workflow files are pushed by a human, not by agents.
- Every commit carries `Co-Authored-By: Claude <noreply@anthropic.com>` when written by an agent. Changes go through a branch and a PR.
- Test the image on `linux/amd64`, which is what the platform runs.
