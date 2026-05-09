#!/bin/bash
# Start Claude Code with local proxy (proxy.ts)
# Usage:
#   ./start.sh                    # interactive TUI mode (requires real terminal)
#   ./start.sh -p "your prompt"   # non-interactive (print & exit)
#   ./start.sh --gateway          # gateway-only mode (飞书/Telegram/etc, no CLI)
#   ./start.sh --help             # show help
#   ./start.sh --version          # show version
#
# proxy.ts is the unified entry point:
#   - With router.enabled=true in ~/.edgeclaw/config.yaml: advanced CCR routing
#   - Otherwise: direct Anthropic→provider conversion
#
# Configuration: edit ~/.edgeclaw/config.yaml or use Settings -> Config in the UI.

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"

log() { echo "[start] $*" >&2; }

# Ensure bun is on PATH
if ! command -v bun &>/dev/null; then
  if [ -f "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Error: bun is not installed. Install it with: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
fi

# Load unified EdgeClaw YAML config after bun is available.
if [ -f "$DIR/edgeclaw-config.ts" ]; then
  EDGECLAW_CONFIG_EXPORTS="$(bun --config=/dev/null run "$DIR/edgeclaw-config.ts" shell-env 2>/dev/null || true)"
  if [ -n "$EDGECLAW_CONFIG_EXPORTS" ]; then
    eval "$EDGECLAW_CONFIG_EXPORTS"
  fi
fi

# ── Parse flags ──
GATEWAY_ONLY=false
HAS_PRINT=false
HAS_HELP_OR_VERSION=false
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --gateway) GATEWAY_ONLY=true ;;
    --help|--version|-v|-V) HAS_PRINT=true; HAS_HELP_OR_VERSION=true; REMAINING_ARGS+=("$arg") ;;
    -p|--print|daemon|--daemon-worker) HAS_PRINT=true; REMAINING_ARGS+=("$arg") ;;
    *) REMAINING_ARGS+=("$arg") ;;
  esac
done
set -- "${REMAINING_ARGS[@]}"

if [ "$HAS_HELP_OR_VERSION" = true ] && [ "$GATEWAY_ONLY" = false ]; then
  exec bun run --preload="$DIR/preload.ts" "$DIR/src/entrypoints/cli.tsx" "$@"
fi

# ── Ensure peekaboo is installed (macOS only, for computer-use MCP) ──
if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v peekaboo &>/dev/null; then
    echo "[start] Installing peekaboo (macOS UI automation)..."
    if command -v brew &>/dev/null; then
      brew install steipete/tap/peekaboo 2>/dev/null || echo "[start] Warning: peekaboo install failed (computer-use will be unavailable)"
    else
      echo "[start] Warning: brew not found, skipping peekaboo install (computer-use will be unavailable)"
    fi
  fi
fi

# ── Ensure clawhub CLI is installed (needed for skill search/install in Web UI) ──
if ! command -v clawhub &>/dev/null; then
  log "Installing clawhub CLI (skill marketplace)..."
  npm install -g clawhub 2>/dev/null || log "Warning: clawhub install failed (skill search will be unavailable)"
fi

# ── Warn about missing recommended tools ──
if ! command -v git &>/dev/null; then
  log "WARNING: git not found — project management and plugin features will not work"
fi
if ! command -v rg &>/dev/null; then
  log "WARNING: ripgrep (rg) not found — code search will fall back to bundled binary or be unavailable"
fi

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    echo "Error: $key is not set. Configure ~/.edgeclaw/config.yaml before starting Claude Code." >&2
    exit 1
  fi
}

require_env EDGECLAW_API_BASE_URL
require_env EDGECLAW_API_KEY
require_env EDGECLAW_MODEL

PROXY_PORT="${EDGECLAW_PROXY_PORT:-18080}"

# ── TTY sanity check for interactive mode ──
# Some embedded terminals (Cursor, VS Code) report a TTY but the Ink/React TUI
# can still misbehave (silent exits, key events not delivered). Warn loudly so
# users don't think the script is "stuck".
if [ "$GATEWAY_ONLY" = false ] && [ "$HAS_PRINT" = false ]; then
  if [ ! -t 1 ]; then
    cat >&2 <<'EOF'
Error: stdout is not a TTY — interactive UI needs a real terminal.

  Examples: Terminal.app, iTerm2, Warp, Alacritty.

  Non-interactive:
    echo "your prompt" | ./start.sh -p --bare
    ./start.sh -p "your prompt" --bare

  Gateway-only (飞书/Telegram etc):
    ./start.sh --gateway
EOF
    exit 1
  fi
  case "${TERM_PROGRAM:-}" in
    vscode|cursor|Cursor)
      cat >&2 <<EOF
[start] WARNING: TERM_PROGRAM=$TERM_PROGRAM detected (Cursor/VS Code embedded terminal).
[start]          The interactive Ink TUI may behave unexpectedly here.
[start]          If you only see the prompt come back, run from Terminal.app / iTerm2 instead,
[start]          or use:  ./start.sh -p "your prompt"   |   ./start.sh --gateway
EOF
      ;;
  esac
fi

export OPENAI_API_KEY="${OPENAI_API_KEY:-$EDGECLAW_API_KEY}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$EDGECLAW_API_BASE_URL}"
export OPENAI_MODEL="${OPENAI_MODEL:-$EDGECLAW_MODEL}"
export PROXY_PORT="$PROXY_PORT"

# ── Start local proxy (if not already running) ──
if curl -s "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
  log "proxy already healthy on http://127.0.0.1:$PROXY_PORT (skipping launch)"
else
  log "starting proxy: bun run $DIR/proxy.ts (log: $DIR/.proxy.log)"
  bun run "$DIR/proxy.ts" > "$DIR/.proxy.log" 2>&1 &
  PROXY_PID=$!
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
      log "proxy ready after ${i} attempts"
      break
    fi
    sleep 0.3
  done
  if ! curl -s "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    echo "Error: proxy failed to start. Check $DIR/.proxy.log" >&2
    cat "$DIR/.proxy.log" >&2
    exit 1
  fi
fi
trap "[ -n \"\$PROXY_PID\" ] && kill \$PROXY_PID 2>/dev/null; [ -n \"\$GATEWAY_PID\" ] && kill \$GATEWAY_PID 2>/dev/null" EXIT

# ── Claude Code env ──
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${EDGECLAW_API_KEY:-dummy-key}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:$PROXY_PORT}"
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"
export CLAUDE_CODE_SYNTAX_HIGHLIGHT=0
export ANTHROPIC_MODEL="$EDGECLAW_MODEL"

# ── Gateway-only mode: start gateway in foreground, no CLI ──
if [ "$GATEWAY_ONLY" = true ]; then
  export GATEWAY_ALLOW_ALL_USERS="${GATEWAY_ALLOW_ALL_USERS:-true}"
  echo "[start] ═══════════════════════════════════════════"
  echo "[start]  Gateway-only mode"
  echo "[start]  Proxy: http://127.0.0.1:$PROXY_PORT"
  echo "[start]  Model: $ANTHROPIC_MODEL"
  echo "[start]  Log:   tail -f $DIR/.gateway.log"
  echo "[start] ═══════════════════════════════════════════"
  exec bun run "$DIR/gateway/index.ts"
fi

# ── Start messaging gateway in background (if enabled) ──
GATEWAY_ENABLED="${GATEWAY_ENABLED:-false}"
if [ "$GATEWAY_ENABLED" = "true" ] || [ "$GATEWAY_ENABLED" = "1" ]; then
  echo "[start] Starting messaging gateway in background..."
  bun run "$DIR/gateway/index.ts" > "$DIR/.gateway.log" 2>&1 &
  GATEWAY_PID=$!
  sleep 1
  echo "[start] Gateway started (PID $GATEWAY_PID, log: .gateway.log)"
fi

# ── Claude Code interactive CLI ──
# PLUGIN_DIR must point at a Claude Code plugin (a directory containing
# .claude-plugin/plugin.json). The default is this repo's bundled turnkey
# plugin. To disable plugin loading entirely, set PLUGIN_DIR= (empty).
DEFAULT_PLUGIN_DIR="$REPO_ROOT/packages/turnkey-cc-plugin"
if [ -z "${PLUGIN_DIR+x}" ]; then
  PLUGIN_DIR="$DEFAULT_PLUGIN_DIR"
fi

PLUGIN_ARGS=()
if [ -n "$PLUGIN_DIR" ]; then
  if [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]; then
    PLUGIN_ARGS=(--plugin-dir "$PLUGIN_DIR")
    log "plugin OK: $PLUGIN_DIR"
  else
    log "WARNING: PLUGIN_DIR=$PLUGIN_DIR is not a valid CC plugin"
    log "         (missing .claude-plugin/plugin.json) — skipping --plugin-dir."
    log "         Passing an invalid plugin dir to cli.tsx silently aborts the TUI."
  fi
else
  log "PLUGIN_DIR explicitly empty — skipping --plugin-dir."
fi

# ── Diagnostics: pass --debug to enable file-based startup tracing ──
# OFF by default. When enabled:
#   /tmp/cc-bisect.log : high-cardinality bisect markers (cli.tsx, main.tsx,
#                        ink.ts, App.tsx, useTextInput.ts) — bypasses Ink's
#                        patchStderr via raw fs.writeSync.
#   /tmp/cc-trace.log  : low-cardinality phase checkpoints (main/run/preAction)
# CC_INPUT_TRACE=1 also enables byte-level keyboard input traces.
# IMPORTANT: do NOT tee stdout from the bun process — it turns the TTY into a
# pipe and Ink falls back to non-interactive mode. Always use file FDs.
HAS_DEBUG=false
REMAINING_AFTER_DEBUG=()
for a in "$@"; do
  if [ "$a" = "--debug" ]; then HAS_DEBUG=true; else REMAINING_AFTER_DEBUG+=("$a"); fi
done
set -- "${REMAINING_AFTER_DEBUG[@]}"
if [ "$HAS_DEBUG" = "true" ]; then
  export CC_TRACE_FILE="${CC_TRACE_FILE:-/tmp/cc-trace.log}"
  export CC_BISECT_FILE="${CC_BISECT_FILE:-/tmp/cc-bisect.log}"
  export CC_INPUT_TRACE="${CC_INPUT_TRACE:-1}"
  : > "$CC_TRACE_FILE"
  : > "$CC_BISECT_FILE"
  log "DEBUG MODE — traces: $CC_TRACE_FILE  bisect: $CC_BISECT_FILE  input-trace: on"
fi

exec bun run "$DIR/src/entrypoints/cli.tsx" "$@" "${PLUGIN_ARGS[@]}"
