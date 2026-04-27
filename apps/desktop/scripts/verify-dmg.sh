#!/usr/bin/env bash
# ============================================================================
# EdgeClaw Desktop DMG Verifier (verify-dmg.sh)
# ----------------------------------------------------------------------------
# 校验一个已经构建好的 EdgeClaw Desktop DMG 是否真的能用：
#   1. DMG 结构完整、可挂载
#   2. App bundle 结构正确（4 个 Helper、Frameworks、node-bin、bun-bin、bundles）
#   3. 代码签名通过 codesign --verify --deep --strict
#   4. claudecodeui-bundle.tar 解开后存在 server/index.js
#   5. claude-code-main-bundle.tar 解开后存在 src/entrypoints/cli.tsx
#   6. 用打包好的 node 直接 spawn server/index.js + 访问 /health
#
# Usage:
#   bash verify-dmg.sh <DMG_PATH> [signed|adhoc]
#   exit 0 = all checks pass; exit 1 = any failure
# ============================================================================

set -uo pipefail

DMG="${1:?Usage: verify-dmg.sh <DMG_PATH> [signed|adhoc]}"
MODE="${2:-auto}"

[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 2; }

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'
CYN=$'\033[0;36m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'

PASS=0; FAIL=0; WARN=0
pass() { PASS=$((PASS+1)); echo "  ${GRN}✓${RST} $*"; }
fail() { FAIL=$((FAIL+1)); echo "  ${RED}✗${RST} $*"; }
warn() { WARN=$((WARN+1)); echo "  ${YEL}⚠${RST} $*"; }
info() { echo "  ${DIM}$*${RST}"; }
hdr()  { echo; echo "${BLD}${CYN}── $* ──${RST}"; }

echo "${BLD}EdgeClaw Desktop DMG Verification${RST}"
echo "${DIM}DMG: ${DMG}${RST}"
echo "${DIM}Mode: ${MODE}${RST}"

# ─────────────── Mount ───────────────
hdr "1. Mount DMG"

MOUNT_OUT="$(hdiutil attach "$DMG" -nobrowse -noautoopen -readonly 2>&1)" || {
  fail "hdiutil attach failed:"; echo "$MOUNT_OUT"; exit 1; }
MOUNT_DIR="$(echo "$MOUNT_OUT" | awk '/\/Volumes\//{for(i=1;i<=NF;i++) if($i~/^\/Volumes\//){p=$i; for(j=i+1;j<=NF;j++) p=p" "$j; print p; exit}}')"
[[ -d "$MOUNT_DIR" ]] || { fail "Cannot determine mount point"; exit 1; }
pass "Mounted at: $MOUNT_DIR"

cleanup() {
  [[ -n "${MOUNT_DIR:-}" ]] && hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-/dev/null}" ]] && rm -rf "$SANDBOX"
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

APP="$MOUNT_DIR/EdgeClaw.app"
[[ -d "$APP" ]] && pass "EdgeClaw.app present" || { fail "EdgeClaw.app missing"; exit 1; }
[[ -L "$MOUNT_DIR/Applications" ]] && pass "/Applications symlink present" \
  || warn "/Applications symlink missing (用户拖拽体验受影响)"

# ─────────────── Bundle structure ───────────────
hdr "2. App bundle structure"

[[ -f "$APP/Contents/MacOS/EdgeClaw" ]] && pass "Main executable present" \
  || fail "Main executable missing"
[[ -f "$APP/Contents/Info.plist" ]]    && pass "Info.plist present" \
  || fail "Info.plist missing"
[[ -d "$APP/Contents/Frameworks/Electron Framework.framework" ]] && pass "Electron Framework present" \
  || fail "Electron Framework missing"

helper_ok=0
for h in "EdgeClaw Helper" "EdgeClaw Helper (GPU)" "EdgeClaw Helper (Renderer)" "EdgeClaw Helper (Plugin)"; do
  if [[ -f "$APP/Contents/Frameworks/${h}.app/Contents/MacOS/${h}" ]]; then
    helper_ok=$((helper_ok+1))
  else
    fail "Missing helper: $h"
  fi
done
[[ "$helper_ok" -eq 4 ]] && pass "All 4 helpers present"

# ─────────────── Resources ───────────────
hdr "3. Bundled resources"

RES="$APP/Contents/Resources"
[[ -f "$RES/app.asar" ]]                && pass "app.asar present ($(du -sh "$RES/app.asar" | awk '{print $1}'))" \
                                        || fail "app.asar missing"
[[ -x "$RES/node-bin/node" ]]           && pass "Bundled Node present ($("$RES/node-bin/node" --version))" \
                                        || fail "node-bin/node missing or not executable"
[[ -x "$RES/bun-bin/bun" ]]             && pass "Bundled Bun present ($("$RES/bun-bin/bun" --version))" \
                                        || fail "bun-bin/bun missing or not executable"
[[ -f "$RES/claudecodeui-bundle.tar" ]] && pass "claudecodeui-bundle.tar present ($(du -sh "$RES/claudecodeui-bundle.tar" | awk '{print $1}'))" \
                                        || fail "claudecodeui-bundle.tar missing"
[[ -f "$RES/claude-code-main-bundle.tar" ]] && pass "claude-code-main-bundle.tar present ($(du -sh "$RES/claude-code-main-bundle.tar" | awk '{print $1}'))" \
                                        || fail "claude-code-main-bundle.tar missing"
[[ -f "$RES/edgeclaw-memory-core-bundle.tar" ]] && pass "edgeclaw-memory-core-bundle.tar present ($(du -sh "$RES/edgeclaw-memory-core-bundle.tar" | awk '{print $1}'))" \
                                        || fail "edgeclaw-memory-core-bundle.tar missing"

# ─────────────── Code signature ───────────────
hdr "4. Code signature"

if codesign --verify --deep --strict "$APP" 2>/tmp/edgeclaw-vrf-cs.log; then
  pass "codesign --verify --deep --strict OK"
else
  fail "codesign verify failed:"; cat /tmp/edgeclaw-vrf-cs.log
fi

CS_INFO="$(codesign -dvv "$APP" 2>&1 || true)"
SIGN_AUTH="$(echo "$CS_INFO" | awk -F'=' '/^Authority=/{print $2; exit}')"
SIGN_TEAM="$(echo "$CS_INFO" | awk -F'=' '/^TeamIdentifier=/{print $2; exit}')"
SIGN_ID="$(  echo "$CS_INFO" | awk -F'=' '/^Identifier=/{print $2; exit}')"
info "Identifier: ${SIGN_ID:-?}"
info "Authority:  ${SIGN_AUTH:-(ad-hoc)}"
info "Team ID:    ${SIGN_TEAM:-(none, ad-hoc)}"

DETECTED_MODE="adhoc"
[[ "$SIGN_AUTH" == *"Developer ID"* ]] && DETECTED_MODE="signed"
[[ "$MODE" == "auto" ]] && MODE="$DETECTED_MODE"

if [[ "$MODE" == "signed" ]]; then
  [[ "$SIGN_AUTH" == *"Developer ID"* ]] \
    && pass "Developer ID signature confirmed" \
    || fail "Expected Developer ID signature, got: ${SIGN_AUTH:-none}"
  if xcrun stapler validate "$APP" >/dev/null 2>&1; then
    pass "Notarization ticket stapled"
  else
    warn "Not stapled (用户首次启动需联网由 macOS 在线校验)"
  fi
elif [[ "$MODE" == "adhoc" ]]; then
  if [[ -z "$SIGN_TEAM" || "$SIGN_TEAM" == "(unset)" ]]; then
    pass "ad-hoc signature confirmed (no Team ID)"
  elif [[ "$DETECTED_MODE" == "signed" ]]; then
    info "DMG actually carries Developer ID signature — switching expectation to 'signed'"
    pass "Developer ID signature present (Team: ${SIGN_TEAM})"
  else
    warn "Unexpected Team ID: $SIGN_TEAM"
  fi
fi

SPCTL_OUT="$(spctl --assess --type execute --verbose "$APP" 2>&1 || true)"
if echo "$SPCTL_OUT" | grep -q "accepted"; then
  pass "Gatekeeper: accepted"
else
  if [[ "$MODE" == "adhoc" ]]; then
    info "Gatekeeper: rejected (expected for ad-hoc — 用户右键打开即可)"
  else
    warn "Gatekeeper: $(echo "$SPCTL_OUT" | head -1)"
  fi
fi

# ─────────────── Bundle extraction smoke test ───────────────
hdr "5. Bundle extraction smoke test"

SANDBOX="$(mktemp -d -t edgeclaw-desktop-verify.XXXXXX)"
info "Sandbox: $SANDBOX"

CCUI_DIR="$SANDBOX/claudecodeui"
mkdir -p "$CCUI_DIR"
if tar xf "$RES/claudecodeui-bundle.tar" -C "$CCUI_DIR" 2>/tmp/edgeclaw-vrf-tar1.log; then
  pass "claudecodeui-bundle.tar extracted ($(du -sh "$CCUI_DIR" | awk '{print $1}'))"
else
  fail "claudecodeui tar extract failed:"; cat /tmp/edgeclaw-vrf-tar1.log
  exit 1
fi

[[ -f "$CCUI_DIR/server/index.js" ]] && pass "server/index.js present" \
  || { fail "server/index.js missing"; exit 1; }
[[ -f "$CCUI_DIR/dist/index.html" ]] && pass "dist/index.html (vite build) present" \
  || warn "dist/index.html missing (UI may not load)"

CCM_DIR="$SANDBOX/claude-code-main"
mkdir -p "$CCM_DIR"
if tar xf "$RES/claude-code-main-bundle.tar" -C "$CCM_DIR" 2>/tmp/edgeclaw-vrf-tar2.log; then
  pass "claude-code-main-bundle.tar extracted ($(du -sh "$CCM_DIR" | awk '{print $1}'))"
else
  fail "claude-code-main tar extract failed:"; cat /tmp/edgeclaw-vrf-tar2.log
  exit 1
fi

[[ -f "$CCM_DIR/src/entrypoints/cli.tsx" ]] && pass "src/entrypoints/cli.tsx present" \
  || fail "src/entrypoints/cli.tsx missing"
[[ -f "$CCM_DIR/preload.ts" ]] && pass "preload.ts present" \
  || warn "preload.ts missing"

MEM_DIR="$SANDBOX/edgeclaw-memory-core"
mkdir -p "$MEM_DIR"
if tar xf "$RES/edgeclaw-memory-core-bundle.tar" -C "$MEM_DIR" 2>/tmp/edgeclaw-vrf-tar3.log; then
  pass "edgeclaw-memory-core-bundle.tar extracted ($(du -sh "$MEM_DIR" | awk '{print $1}'))"
else
  fail "edgeclaw-memory-core tar extract failed:"; cat /tmp/edgeclaw-vrf-tar3.log
  exit 1
fi

[[ -f "$MEM_DIR/lib/index.js" ]] && pass "edgeclaw-memory-core/lib/index.js present" \
  || fail "edgeclaw-memory-core/lib/index.js missing"

# ─────────────── claudecodeui server smoke test ───────────────
hdr "6. claudecodeui server smoke test"

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});' 2>/dev/null || echo 28790)"

# Need a structured config file to satisfy assertRequiredEdgeClawEnv()
# Schema: models.providers.<id>.{baseUrl,apiKey}, models.entries.<id>.{provider,name}, agents.main.model
# Bake the dynamic SERVER_PORT into runtime.serverPort because applyConfigToProcessEnv
# overrides whatever env was set when claudecodeui boots.
mkdir -p "$SANDBOX/home/.edgeclaw"
cat > "$SANDBOX/home/.edgeclaw/config.yaml" <<EOF
version: 1
runtime:
  host: 127.0.0.1
  serverPort: ${PORT}
  vitePort: 0
models:
  providers:
    edgeclaw:
      type: anthropic
      baseUrl: https://api.anthropic.com
      apiKey: smoke-test-not-real
  entries:
    default:
      provider: edgeclaw
      name: claude-sonnet-4-5-20250929
agents:
  main:
    model: default
memory:
  enabled: false
EOF
pass "Stub config.yaml created (serverPort=${PORT})"
SRV_LOG="$SANDBOX/server.log"

info "Spawning: node-bin/node $CCUI_DIR/server/index.js (port $PORT)"
(
  cd "$CCUI_DIR"
  HOME="$SANDBOX/home" \
  SERVER_PORT="$PORT" \
  BUN_BIN="$RES/bun-bin/bun" \
  CLAUDE_CODE_MAIN_DIR="$CCM_DIR" \
  NO_COLOR=1 FORCE_COLOR=0 \
  "$RES/node-bin/node" server/index.js \
    > "$SRV_LOG" 2>&1 &
  echo $!
) > "$SANDBOX/srv.pid"
SRV_PID="$(cat "$SANDBOX/srv.pid")"

SRV_OK=0
for i in $(seq 1 60); do
  if /usr/bin/curl -s -m 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    SRV_OK=1; break
  fi
  sleep 0.5
  if ! kill -0 "$SRV_PID" 2>/dev/null; then break; fi
done

if [[ "$SRV_OK" == "1" ]]; then
  pass "Server responding on http://127.0.0.1:${PORT}/health"
else
  fail "Server did not respond within 30s"
  echo "  ${DIM}Last 40 lines of server log:${RST}"
  tail -40 "$SRV_LOG" | sed 's/^/    /'
fi

if kill -0 "$SRV_PID" 2>/dev/null; then
  kill "$SRV_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$SRV_PID" 2>/dev/null || true
  pass "Server terminated cleanly"
fi

# ─────────────── Summary ───────────────
hdr "Summary"
echo "  ${GRN}Pass${RST}: $PASS    ${YEL}Warn${RST}: $WARN    ${RED}Fail${RST}: $FAIL"
echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "${BLD}${GRN}✓ DMG verification PASSED${RST}"
  exit 0
else
  echo "${BLD}${RED}✗ DMG verification FAILED${RST}"
  exit 1
fi
