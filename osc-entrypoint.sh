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

# Git author. The image configures none, and the bridge commits after every turn (a commit without an
# author fails). An identity the home volume already has is left alone: it is tested by the email, which
# is what git refuses to commit without. The values are image ENV (Dockerfile.osc).
if [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
  if [ -n "${LIIVO_GIT_AUTHOR_NAME:-}" ] && [ -n "${LIIVO_GIT_AUTHOR_EMAIL:-}" ]; then
    if git config --global user.name "$LIIVO_GIT_AUTHOR_NAME" && git config --global user.email "$LIIVO_GIT_AUTHOR_EMAIL"; then
      log "git author set to $LIIVO_GIT_AUTHOR_NAME"
    else
      log "WARNING: could not set the git author"
    fi
  else
    log "WARNING: no git author is configured and LIIVO_GIT_AUTHOR_NAME / LIIVO_GIT_AUTHOR_EMAIL are not set: commits in the workspace will fail"
  fi
fi

# The bridge (amendment 6): fetched from the gateway at every start, verified, cached under
# ~/.liivo/bridge and run by the supervisor below. The supervisor writes its state to state.json,
# which the edit proxy reports in /__liivo/status; the file is written before the proxy starts so a
# state left on the volume by an earlier run is never reported.
BRIDGE_DIR="$HOME/.liivo/bridge"
BRIDGE_PORT=4777
mkdir -p "$BRIDGE_DIR"
write_bridge_state() {
  local tmp="$BRIDGE_DIR/.state.$$"
  case "${2:-}" in
    '') printf '{"state":"%s","version":null}\n' "$1" > "$tmp" ;;
    *) printf '{"state":"%s","version":"%s"}\n' "$1" "$2" > "$tmp" ;;
  esac
  mv -f "$tmp" "$BRIDGE_DIR/state.json"
}
write_bridge_state starting

# Edit proxy and preview forwarder on PORT. It is the tenant boundary: every
# request needs its own session (docs/block.md). It forwards to
# 127.0.0.1:$PREVIEW_PORT and is restarted by the loop if it exits. It starts
# before the clone so the git credential helper can reach its signing socket.
# It gets a clean environment (no tokens) and the handoff key on stdin, so the
# key is in no environment block that project processes could inherit.
LIB_DIR="${LIIVO_LIB_DIR:-/usr/local/lib/liivo}"
FORWARDER="$LIB_DIR/preview-forwarder.js"
FETCHER="$LIB_DIR/bridge-fetch.js"
forwarder_started=""
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
        LIIVO_BRIDGE_PORT="$BRIDGE_PORT" \
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
  forwarder_started=1
fi
unset handoff_key

# Bridge supervisor, in the background so the clone, the hooks and `exec coder agent` below are never
# delayed. bridge-fetch.js waits for the edit proxy's signer (409 until the gateway has told the
# workspace who it belongs to), fetches and verifies the bridge and prints its version (exit 3: no
# verified bridge now; exit 2: it cannot work at all). The bridge runs with `env -i` and the list
# below only: the Claude credential it needs, and nothing of the agent (no HANDOFF_KEY, no
# CODER_AGENT_*) or of the other secrets. A gateway failure backs off 5, 10, 20, 40, then 60 s; the
# bridge restarts after 1 to 30 s. The tenant's project code runs as the same uid and can reach the
# bridge's files and loopback port; docs/block.md says so.
supervise_bridge() {
  local gw_delay=5 run_delay=1 rc version started bpid
  local -a bridge_env
  while true; do
    rc=0
    version="$(node "$FETCHER")" || rc=$?
    case "$version" in
      '' | *[!A-Za-z0-9._-]*) [ "$rc" -ne 0 ] || rc=3 ;;
    esac
    if [ "$rc" -eq 2 ]; then
      log "bridge fetcher has a configuration error (exit 2), not restarting"
      write_bridge_state unavailable
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      write_bridge_state unavailable
      log "no verified bridge (fetcher exit $rc), trying again in ${gw_delay}s"
      sleep "$gw_delay"
      gw_delay=$((gw_delay * 2))
      [ "$gw_delay" -le 60 ] || gw_delay=60
      continue
    fi
    gw_delay=5
    bridge_env=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}"
      LIIVO_REPO_DIR="$PROJECT_DIR" LIIVO_PREVIEW_PORT="$PREVIEW_PORT"
      LIIVO_GATEWAY_URL="${LIIVO_GATEWAY_URL:-}" LIIVO_INSTANCE="$LIIVO_INSTANCE"
      OSC_HOSTNAME="${OSC_HOSTNAME:-}" LIIVO_PREVIEW_URL="${LIIVO_EDIT_URL:-}"
      LIIVO_BRIDGE_PORT="$BRIDGE_PORT" DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1)
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || bridge_env+=(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
    [ -z "${ANTHROPIC_API_KEY:-}" ] || bridge_env+=(ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
    while true; do
      started="$(date +%s)"
      env -i "${bridge_env[@]}" node "$BRIDGE_DIR/current/package/server.mjs" &
      bpid=$!
      write_bridge_state running "$version"
      printf '{"version":"%s","pid":%s,"startedAt":"%s"}\n' "$version" "$bpid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BRIDGE_DIR/running.json"
      rc=0
      wait "$bpid" || rc=$?
      write_bridge_state starting "$version"
      [ $(($(date +%s) - started)) -lt 60 ] || run_delay=1
      log "bridge exited ($rc), restarting in ${run_delay}s"
      sleep "$run_delay"
      run_delay=$((run_delay * 2))
      [ "$run_delay" -le 30 ] || run_delay=30
    done
  done
}
if [ -n "$forwarder_started" ] && [ -f "$FETCHER" ]; then
  supervise_bridge < /dev/null &
  log "bridge supervisor started"
else
  log "WARNING: no bridge supervisor (the preview forwarder or $FETCHER is missing)"
  write_bridge_state unavailable
fi

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
    # The bridge stops and restarts start.sh through /tmp/liivo-start-<dir>.pid, which holds the id of a
    # process group (it kills the group). So start.sh runs as the leader of its own session and the
    # leader's id is written before it starts.
    start_pid_file="/tmp/liivo-start-$(basename "$PROJECT_DIR").pid"
    # shellcheck disable=SC2016 # $$ and $1 are for the inner bash, not this one
    if command -v setsid >/dev/null 2>&1; then
      setsid --wait bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "$start_pid_file" bash .liivo/start.sh \
        || echo "start.sh exited with an error"
    else
      bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "$start_pid_file" bash .liivo/start.sh \
        || echo "start.sh exited with an error"
    fi
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
