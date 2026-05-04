#!/usr/bin/env bash
# ============================================================================
# CI E2E Test Runner for EdgeClaw
# ----------------------------------------------------------------------------
# Starts UI server + proxy, runs XHS smoke test, tears everything down.
# Designed for self-hosted macOS runners (GitHub Actions or standalone).
#
# Usage:
#   bash scripts/ci-e2e.sh              # smoke mode (default)
#   bash scripts/ci-e2e.sh full         # full CCR mode (needs Sonnet)
#   bash scripts/ci-e2e.sh auto         # auto-detect
#
# Prerequisites on the runner:
#   - Node.js >= 22 (fnm or system)
#   - Bun (for proxy.ts)
#   - Google Chrome (for headless screenshot)
#   - ~/.edgeclaw/config.yaml with valid provider config
#   - claude-code-main/.env with OPENAI_API_KEY (for Sonnet probe)
#   - npm install in ui/ (ws + js-yaml)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:-smoke}"

UI_PORT="${EDGECLAW_UI_PORT:-3001}"
PROXY_PORT="${PROXY_PORT:-18080}"

UI_PID=""

cleanup() {
  echo "[ci] Cleaning up..."
  [[ -n "$UI_PID" ]] && kill "$UI_PID" 2>/dev/null && echo "[ci] UI server stopped"
  wait 2>/dev/null
}
trap cleanup EXIT

echo "════════════════════════════════════════"
echo "  EdgeClaw CI E2E Test"
echo "  Mode: ${MODE}  ·  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════"
echo

# ── Pre-flight ──
echo "[ci] Pre-flight checks..."

command -v node >/dev/null || { echo "ERROR: node not found"; exit 1; }
echo "  ✓ Node: $(node --version)"

command -v bun >/dev/null || { echo "ERROR: bun not found"; exit 1; }
echo "  ✓ Bun: $(bun --version)"

[[ -f "$HOME/.edgeclaw/config.yaml" ]] || { echo "ERROR: ~/.edgeclaw/config.yaml missing"; exit 1; }
echo "  ✓ config.yaml exists"

[[ -d "$REPO_ROOT/ui/node_modules" ]] || { echo "ERROR: ui/node_modules missing — run npm install in ui/"; exit 1; }
echo "  ✓ ui/node_modules present"

[[ -d "$REPO_ROOT/claude-code-main/node_modules" ]] || { echo "ERROR: claude-code-main/node_modules missing — run bun install"; exit 1; }
echo "  ✓ claude-code-main/node_modules present"

[[ -d "/Applications/Google Chrome.app" ]] && echo "  ✓ Chrome installed" || echo "  ⚠ Chrome missing (headless screenshot will fail)"

echo

# ── Start UI server (it auto-starts embedded proxy) ──
if curl -s "http://127.0.0.1:${UI_PORT}/health" >/dev/null 2>&1; then
  echo "[ci] UI server already running on :${UI_PORT}"
else
  echo "[ci] Starting UI server (node server/index.js)..."
  cd "$REPO_ROOT/ui"
  PORT="$UI_PORT" node server/index.js > /tmp/ci-ui.log 2>&1 &
  UI_PID=$!
  cd "$REPO_ROOT"

  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:${UI_PORT}/health" >/dev/null 2>&1; then
      echo "[ci] UI server ready (attempt $i)"
      break
    fi
    sleep 1
  done

  if ! curl -s "http://127.0.0.1:${UI_PORT}/health" >/dev/null 2>&1; then
    echo "ERROR: UI server failed to start. Log:"
    cat /tmp/ci-ui.log 2>/dev/null || true
    exit 1
  fi
fi

export EDGECLAW_ROOT="$REPO_ROOT"
export EDGECLAW_UI_PORT="$UI_PORT"
export EDGECLAW_ENV_PATH="$REPO_ROOT/claude-code-main/.env"

# ── Phase 1: Mac App GUI Test ──
echo
echo "[ci] Phase 1: Mac App GUI Test..."
echo

GUI_EXIT=0
if [[ -f "/Applications/EdgeClaw.app/Contents/MacOS/EdgeClaw" ]]; then
  node "$REPO_ROOT/scripts/ci-gui-test.mjs" || GUI_EXIT=$?
else
  echo "[ci] ⚠ EdgeClaw.app not installed, skipping GUI test"
fi

# ── Phase 2: XHS E2E Agent Test ──
echo
echo "[ci] Phase 2: XHS E2E Agent Test (${MODE})..."
echo

node "$REPO_ROOT/.cursor/skills/test-xhs-e2e/run-test.mjs" "$MODE"
AGENT_EXIT=$?

# Combine results
EXIT_CODE=0
[[ $GUI_EXIT -ne 0 ]] && EXIT_CODE=1
[[ $AGENT_EXIT -ne 0 ]] && EXIT_CODE=1

echo
echo "════════════════════════════════════════"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "  ✅ ALL TESTS PASSED"
else
  echo "  ❌ SOME TESTS FAILED"
  [[ $GUI_EXIT -ne 0 ]]   && echo "     GUI: FAIL (exit $GUI_EXIT)"
  [[ $AGENT_EXIT -ne 0 ]] && echo "     Agent: FAIL (exit $AGENT_EXIT)"
fi
echo "════════════════════════════════════════"

exit $EXIT_CODE
