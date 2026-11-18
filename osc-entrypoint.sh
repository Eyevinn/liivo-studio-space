#!/bin/bash
# OSC entrypoint for the Liivo Studio workspace block.
# Maps OSC option variables to what the workspace needs, prepares the project
# checkout, then runs the Coder agent. Secret values are never printed.
set -eu

log() { echo "osc-entrypoint: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# The agent cannot start without these. They are instance options (the token is
# a service secret), so a missing value means the instance was created wrong.
[ -n "${CODER_AGENT_URL:-}" ] || die "CODER_AGENT_URL is required (instance option AgentUrl: the public URL of the Coder instance)"
[ -n "${CODER_AGENT_TOKEN:-}" ] || die "CODER_AGENT_TOKEN is required (instance option AgentToken: the Coder agent token, normally a {{secrets.x}} reference)"

HOME="${HOME:-/home/coder}"
export HOME
PROJECT_DIR="${PROJECT_DIR:-$HOME/project}"
PREVIEW_PORT="${PREVIEW_PORT:-3000}"
case "$PREVIEW_PORT" in
  ''|*[!0-9]*) die "PREVIEW_PORT must be a number, got '$PREVIEW_PORT'" ;;
esac
[ "$PREVIEW_PORT" -ge 1 ] && [ "$PREVIEW_PORT" -le 65535 ] || die "PREVIEW_PORT out of range: $PREVIEW_PORT"

# Token auth for the agent, and the variables Liivo tooling in the project reads.
export CODER_AGENT_AUTH="${CODER_AGENT_AUTH:-token}"
export LIIVO_REPO_DIR="$PROJECT_DIR"
export LIIVO_PREVIEW_PORT="$PREVIEW_PORT"
if [ -n "${OSC_HOSTNAME:-}" ]; then
  export LIIVO_EDIT_URL="https://${OSC_HOSTNAME}"
fi

# Claude Code reads its credential from its own environment. The platform passes
# the tenant's credential as the options ClaudeCodeOauthToken and AnthropicApiKey
# (the Agent Tasks mechanism). The credential type the tenant does not have
# arrives as the literal "unset" (or empty). Never print either value. Code
# running in the workspace can read them (docs/block.md).
for claude_var in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do
  claude_val="${!claude_var:-}"
  if [ -n "$claude_val" ] && [ "$claude_val" != "unset" ]; then
    export "${claude_var?}"
  else
    unset "$claude_var"
  fi
done
unset claude_var claude_val

# Edit proxy key (option HandoffKey): base64 of 32 bytes, read here once and
# unset, so the coder agent and everything it starts never inherit it. It
# reaches the edit proxy on stdin only (see below). A missing or malformed key
# is not fatal: the proxy then refuses every request with 503 (fail closed).
handoff_key="${HANDOFF_KEY:-}"
unset HANDOFF_KEY
if [ -z "$handoff_key" ]; then
  log "WARNING: HANDOFF_KEY is not set (option HandoffKey): the edit proxy answers 503 to every request until the project is recreated"
elif [ "$(printf '%s' "$handoff_key" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" != "32" ]; then
  log "WARNING: HANDOFF_KEY is not 32 bytes of base64: the edit proxy answers 503 to every request until the project is recreated"
  handoff_key=""
fi
# The instance name is the first label of the public host. Only used for the
# redirect to the gateway before any handoff has told the proxy better.
osc_host="${OSC_HOSTNAME:-}"
LIIVO_INSTANCE="${osc_host%%.*}"

# The home directory may be an empty volume: seed it from the image once.
[ -w "$HOME" ] || die "$HOME is not writable by uid $(id -u)"
if [ ! -f "$HOME/.liivo-seeded" ] && [ -d /opt/home-skel ]; then
  # Copy the skeleton's children, not "/opt/home-skel/.": cp -a on "." tries to set the timestamps
  # and mode of the mounted volume root, which a non-owner cannot do (EPERM, the instance crash-loops).
  shopt -s dotglob nullglob
  cp -a --update=none /opt/home-skel/* "$HOME/"
  shopt -u dotglob nullglob
  touch "$HOME/.liivo-seeded"
fi
mkdir -p "$HOME/.liivo"
chmod 700 "$HOME/.liivo" 2>/dev/null || true

# Edit proxy and preview forwarder on PORT. It is the tenant boundary: every
# request needs its own session (docs/block.md). It forwards to
# 127.0.0.1:$PREVIEW_PORT and is restarted by the loop if it exits. It starts
# before the clone so the git credential helper can reach its signing socket.
# It gets a clean environment (no tokens) and the handoff key on stdin, so the
# key is in no environment block that project processes could inherit.
FORWARDER=/usr/local/lib/liivo/preview-forwarder.js
# The orchestrator does not set PORT: the instance's container port is fixed at 8080.
PORT="${PORT:-8080}"
if [ "$PORT" = "$PREVIEW_PORT" ]; then
  log "WARNING: PORT equals PREVIEW_PORT ($PORT), preview forwarder not started"
elif [ ! -f "$FORWARDER" ]; then
  log "WARNING: $FORWARDER not found, preview forwarder not started"
else
  (
    delay=1
    while true; do
      rc=0
      printf '%s' "$handoff_key" | env -i PATH="$PATH" HOME="$HOME" PORT="$PORT" PREVIEW_PORT="$PREVIEW_PORT" \
        PROJECT_DIR="$PROJECT_DIR" LIIVO_INSTANCE="$LIIVO_INSTANCE" LIIVO_GATEWAY_URL="${LIIVO_GATEWAY_URL:-}" \
        node "$FORWARDER" || rc=$?
      if [ "$rc" -eq 2 ]; then
        echo "osc-entrypoint: preview forwarder has a configuration error (exit 2), not restarting" >&2
        break
      fi
      echo "osc-entrypoint: preview forwarder exited ($rc), restarting in ${delay}s" >&2
      sleep "$delay"
      delay=$((delay * 2))
      [ "$delay" -le 30 ] || delay=30
    done
  ) < /dev/null &
  log "preview forwarder on port $PORT -> 127.0.0.1:$PREVIEW_PORT"
fi
unset handoff_key

# Never show credentials that may be embedded in a git URL. The userinfo part
# ends at the LAST '@' before the first '/' after the scheme, so a password that
# itself contains '@' is masked completely. URLs without a scheme (scp-style
# git@host:o/r.git) are left as they are.
mask_url() { echo "$1" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/]*@#\1***@#'; }

# Project checkout: clone on first start, leave it alone afterwards. A failed
# clone does not stop the agent, so the workspace stays reachable for debugging.
if [ -n "${REPO_URL:-}" ]; then
  case "$REPO_URL" in
    -*) die "REPO_URL must not start with '-'" ;;
  esac
  if [ -d "$PROJECT_DIR/.git" ]; then
    log "project already checked out in $PROJECT_DIR"
  elif [ -e "$PROJECT_DIR" ] && [ -n "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
    log "WARNING: $PROJECT_DIR exists and is not a git checkout, skipping clone"
  else
    log "cloning $(mask_url "$REPO_URL") into $PROJECT_DIR"
    if git clone -- "$REPO_URL" "$PROJECT_DIR" > "$HOME/liivo-clone.log" 2>&1; then
      if [ -n "${REPO_BRANCH:-}" ]; then
        (cd "$PROJECT_DIR" && { git checkout "$REPO_BRANCH" 2>/dev/null || git checkout -b "$REPO_BRANCH"; }) \
          || log "WARNING: could not switch to branch $REPO_BRANCH"
      fi
      touch "$HOME/.liivo/project-cloned"
    else
      log "WARNING: git clone failed, see $HOME/liivo-clone.log (agent starts anyway)"
    fi
  fi
else
  mkdir -p "$PROJECT_DIR"
  log "REPO_URL not set, empty project directory $PROJECT_DIR"
fi

# Project hooks run in the background so the workspace is usable at once.
# setup.sh runs once (marker file), start.sh on every start.
# Isolation limit: the unset below only keeps the agent variables out of the
# hooks' own environment (they are not inherited or printed by accident). It is
# not a security boundary. The hooks run as the same uid as the agent, so a hook
# can still read the agent's /proc/<pid>/environ. The entrypoint runs as uid 1000
# without sudo and cannot drop to another uid. The token only grants access to
# this one workspace's agent endpoints, and the hooks are the workspace owner's
# own repo code.
run_hooks() {
  cd "$PROJECT_DIR" || exit 0
  if command -v mise >/dev/null 2>&1; then
    mise trust -a >/dev/null 2>&1 || true
    mise install >/dev/null 2>&1 || true
  fi
  if [ -f .liivo/setup.sh ] && [ ! -f "$HOME/.liivo/setup.done" ]; then
    echo "running .liivo/setup.sh"
    if bash .liivo/setup.sh; then
      touch "$HOME/.liivo/setup.done"
    else
      echo "setup.sh failed, it runs again on the next start"
    fi
  fi
  if [ -f .liivo/start.sh ]; then
    echo "running .liivo/start.sh"
    bash .liivo/start.sh || echo "start.sh exited with an error"
  fi
}
if [ -d "$PROJECT_DIR" ]; then
  (
    unset CODER_AGENT_TOKEN CODER_AGENT_URL CODER_AGENT_AUTH CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
    # Project processes bind to loopback: the edit proxy is the only
    # listener on a non-loopback address (contract in docs/block.md).
    export HOST=127.0.0.1
    run_hooks
  ) < /dev/null > "$HOME/liivo-run.log" 2>&1 &
fi

# No Docker engine in the instance: switch off the agent's devcontainer
# detection, which otherwise loops on "docker: command not found".
export CODER_AGENT_DEVCONTAINERS_ENABLE=false

log "starting coder agent against $CODER_AGENT_URL"
cd "$PROJECT_DIR" 2>/dev/null || cd "$HOME"
exec coder agent
