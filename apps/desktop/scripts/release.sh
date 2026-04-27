#!/usr/bin/env bash
# ============================================================================
# EdgeClaw Desktop macOS One-Click Packager (release.sh)
# ----------------------------------------------------------------------------
# Adapted from OpenClaw's release.sh. Differences:
#   - Builds claudecodeui (vite build) instead of OpenClaw gateway
#   - Two tarballs (claudecodeui-bundle.tar + claude-code-main-bundle.tar)
#   - Bundles both Node 22 (for claudecodeui server) and Bun (for claude-code-main)
#   - Bundle ID: cc.edgeclaw.desktop
#
# Usage:
#   bash scripts/release.sh                 # auto: signed if cert in keychain, else ad-hoc
#   bash scripts/release.sh --ad-hoc        # force ad-hoc (local test)
#   bash scripts/release.sh --signed        # require Developer ID; fail if missing
#   bash scripts/release.sh --skip-notarize # signed but no notarization
#   bash scripts/release.sh --skip-build    # reuse existing claudecodeui/dist
#   bash scripts/release.sh --skip-verify   # skip post-build verification
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
RESOURCES="${DESKTOP_DIR}/resources"
ENTITLEMENTS="${RESOURCES}/entitlements.mac.plist"
NODE_BIN="${RESOURCES}/node-bin/node"
BUN_BIN="${RESOURCES}/bun-bin/bun"

CLAUDECODEUI_DIR="${REPO_ROOT}/claudecodeui"
CLAUDE_CODE_MAIN_DIR="${REPO_ROOT}/claude-code-main"
MEMORY_CORE_DIR="${REPO_ROOT}/edgeclaw-memory-core"

CCUI_BUNDLE="${RESOURCES}/claudecodeui-bundle.tar"
CCM_BUNDLE="${RESOURCES}/claude-code-main-bundle.tar"
MEM_BUNDLE="${RESOURCES}/edgeclaw-memory-core-bundle.tar"

# ─────────────── Args ───────────────
MODE="auto"
SKIP_BUILD=0
SKIP_NOTARIZE=0
SKIP_VERIFY=0
KEYCHAIN_PROFILE="${NOTARIZE_KEYCHAIN_PROFILE:-EdgeClaw}"

for arg in "$@"; do
  case "$arg" in
    --ad-hoc|--adhoc) MODE="adhoc" ;;
    --signed)         MODE="signed" ;;
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-notarize)  SKIP_NOTARIZE=1 ;;
    --skip-verify)    SKIP_VERIFY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg (use --help)" >&2; exit 2 ;;
  esac
done

# ─────────────── Pretty printing ───────────────
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'
CYN=$'\033[0;36m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
step_n=0
step() { step_n=$((step_n+1)); echo; echo "${BLD}${CYN}[$step_n] $*${RST}"; }
ok()   { echo "  ${GRN}✓${RST} $*"; }
warn() { echo "  ${YEL}⚠${RST} $*"; }
fail() { echo "  ${RED}✗ $*${RST}"; exit 1; }
info() { echo "  ${DIM}$*${RST}"; }

VERSION="$(node -e "console.log(require('${DESKTOP_DIR}/package.json').version)")"
APP_OUT="${DESKTOP_DIR}/dist-electron/mac-arm64/EdgeClaw.app"
DMG_OUT="${DESKTOP_DIR}/dist-electron/EdgeClaw-${VERSION}-arm64.dmg"

echo "${BLD}EdgeClaw Desktop One-Click Packager${RST}"
echo "${DIM}Version ${VERSION} · arm64 · $(date '+%Y-%m-%d %H:%M')${RST}"

# ============================================================================
step "Pre-flight checks"
# ============================================================================

IDENTITY=""
TEAM_ID=""
if [[ "$MODE" != "adhoc" ]]; then
  IDENTITY="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  if [[ -z "$IDENTITY" ]]; then
    if [[ "$MODE" == "signed" ]]; then
      fail "No 'Developer ID Application' cert found. Run: security find-identity -p codesigning -v"
    fi
    warn "No Developer ID cert in keychain → falling back to ad-hoc mode"
    MODE="adhoc"
  else
    MODE="signed"
    TEAM_ID="$(echo "$IDENTITY" | grep -oE '\([A-Z0-9]+\)$' | tr -d '()')"
    ok "Mode: signed   ·   Cert: ${IDENTITY}   ·   Team: ${TEAM_ID}"
  fi
fi
[[ "$MODE" == "adhoc" ]] && ok "Mode: ad-hoc (local-test, no notarization)"

if [[ "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
  if xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    ok "Notarize profile: ${KEYCHAIN_PROFILE}"
  else
    warn "Keychain profile '${KEYCHAIN_PROFILE}' not configured → skipping notarization"
    warn "Configure with: xcrun notarytool store-credentials \"${KEYCHAIN_PROFILE}\" \\"
    warn "    --apple-id <email> --team-id ${TEAM_ID:-XXXXXXXXXX} --password <app-specific-pwd>"
    SKIP_NOTARIZE=1
  fi
fi

[[ -f "$ENTITLEMENTS" ]] || fail "Missing entitlements: ${ENTITLEMENTS}"
ok "Entitlements: $(basename "$ENTITLEMENTS")"

[[ -d "$CLAUDECODEUI_DIR" ]] || fail "Missing claudecodeui at ${CLAUDECODEUI_DIR}"
[[ -d "$CLAUDE_CODE_MAIN_DIR" ]] || fail "Missing claude-code-main at ${CLAUDE_CODE_MAIN_DIR}"
[[ -d "$MEMORY_CORE_DIR" ]] || fail "Missing edgeclaw-memory-core at ${MEMORY_CORE_DIR}"
[[ -f "${MEMORY_CORE_DIR}/lib/index.js" ]] \
  || fail "edgeclaw-memory-core/lib/index.js missing — run: (cd ${MEMORY_CORE_DIR} && npm run build)"
ok "Source trees present (claudecodeui + claude-code-main + edgeclaw-memory-core)"

# Bundled Node binary
if [[ ! -x "$NODE_BIN" ]]; then
  warn "Node binary missing → downloading…"
  bash "${SCRIPT_DIR}/download-node.sh" || fail "download-node.sh failed"
fi
ok "Bundled Node: $("$NODE_BIN" --version)"

# Bundled Bun binary
if [[ ! -x "$BUN_BIN" ]]; then
  warn "Bun binary missing → downloading…"
  bash "${SCRIPT_DIR}/download-bun.sh" || fail "download-bun.sh failed"
fi
ok "Bundled Bun: $("$BUN_BIN" --version)"

# ============================================================================
step "Build claudecodeui (vite)"
# ============================================================================

if [[ "$SKIP_BUILD" == "1" ]]; then
  if [[ -d "${CLAUDECODEUI_DIR}/dist" ]]; then
    warn "Skipped (--skip-build). Reusing existing claudecodeui/dist/"
  else
    fail "Cannot --skip-build: claudecodeui/dist/ missing."
  fi
else
  info "npm run build (vite)…"
  (cd "$CLAUDECODEUI_DIR" && npm run build) >/tmp/edgeclaw-ccui-build.log 2>&1 \
    || { tail -40 /tmp/edgeclaw-ccui-build.log; fail "claudecodeui build failed (see /tmp/edgeclaw-ccui-build.log)"; }
  ok "claudecodeui built"
fi

# ============================================================================
step "Sign native binaries (signed mode only)"
# ============================================================================

if [[ "$MODE" == "signed" ]]; then
  sign_count=0; sign_fail=0
  # Sign all macOS-targeted binaries inside the source trees BEFORE we tar them.
  # Apple notarization recursively scans archives (including .tar bundles), so any
  # unsigned Mach-O binary inside the .tar will fail the notary check.
  # Cover:
  #  - native node addons:  *.node, *.dylib, *.so, *.bare, spawn-helper
  #  - vendored ripgrep:    rg under any *darwin* path
  #    (matches arm64-darwin/, x64-darwin/, aarch64-apple-darwin/)
  # Search roots include claude-code-main/src/ because some packages vendor
  # binaries outside node_modules (e.g. src/utils/vendor/ripgrep/arm64-darwin/rg).
  while IFS= read -r -d '' f; do
    if codesign --force --sign "$IDENTITY" --timestamp --options runtime \
         --entitlements "$ENTITLEMENTS" "$f" >/dev/null 2>&1; then
      sign_count=$((sign_count+1))
    else
      sign_fail=$((sign_fail+1))
    fi
  done < <(find \
    "${CLAUDECODEUI_DIR}/node_modules" \
    "${CLAUDE_CODE_MAIN_DIR}/node_modules" \
    "${CLAUDE_CODE_MAIN_DIR}/src" \
    -type f \
    \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \
       -o -name "*.bare" -o -name "spawn-helper" \
       -o \( -name "rg" -path "*darwin*" \) \) -print0 2>/dev/null)

  codesign --force --sign "$IDENTITY" --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" "$NODE_BIN" >/dev/null 2>&1 \
    && sign_count=$((sign_count+1))
  codesign --force --sign "$IDENTITY" --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" "$BUN_BIN" >/dev/null 2>&1 \
    && sign_count=$((sign_count+1))

  ok "Signed ${sign_count} native binaries"
  [[ "$sign_fail" -gt 0 ]] && warn "${sign_fail} binaries failed (often non-critical optional deps)"
else
  info "Skipped (ad-hoc mode does not pre-sign native binaries)"
fi

# ============================================================================
step "Create bundles (claudecodeui + claude-code-main)"
# ============================================================================

# NODE_MODULES_EXCLUDES: aggressively trim node_modules — these dirs/files are
# never imported at runtime, so safe to drop. Patterns are scoped to node_modules
# to avoid breaking source trees that DO ship .md / examples (e.g. claude-code-main
# bundles skill .md files via Bun text imports → see src/skills/bundled/*Content.ts).
NODE_MODULES_EXCLUDES=(
  --exclude='*.map'
  --exclude='node_modules/.cache'
  --exclude='node_modules/.bin'
  --exclude='node_modules/typescript'
  --exclude='node_modules/@typescript'
  --exclude='node_modules/@babel'
  --exclude='node_modules/playwright-core'
  --exclude='node_modules/@vitest'
  --exclude='node_modules/vitest'
  --exclude='node_modules/@types'
  --exclude='node_modules/prettier'
  --exclude='node_modules/oxlint'
  --exclude='node_modules/@esbuild'
  --exclude='node_modules/esbuild'
  --exclude='node_modules/rollup'
  --exclude='node_modules/@rollup'
  --exclude='node_modules/eslint'
  --exclude='node_modules/@eslint'
  --exclude='node_modules/vite'
  --exclude='node_modules/@vitejs'
  --exclude='node_modules/**/examples'
  --exclude='node_modules/**/test'
  --exclude='node_modules/**/tests'
  --exclude='node_modules/**/__tests__'
  --exclude='node_modules/**/*.md'
)

# claudecodeui bundle: server/, dist/, shared/, scripts/, package.json, node_modules
# Note: claudecodeui server source is JS, no runtime .md imports → safe to also
# strip top-level test/__tests__ dirs.
rm -f "$CCUI_BUNDLE"
(cd "$CLAUDECODEUI_DIR" && tar cf "$CCUI_BUNDLE" \
  "${NODE_MODULES_EXCLUDES[@]}" \
  --exclude='**/__tests__' \
  --exclude='**/*.test.js' \
  package.json server/ shared/ dist/ scripts/ node_modules/) \
  || fail "claudecodeui tar creation failed"
CCUI_MB=$(du -sm "$CCUI_BUNDLE" | awk '{print $1}')
ok "claudecodeui bundle: ${CCUI_MB}MB → $(basename "$CCUI_BUNDLE")"

# claude-code-main bundle: src/, gateway/, preload.ts, proxy.ts, router.ts,
# package.json, bunfig.toml, edgeclaw-config.ts, scripts/, node_modules
# IMPORTANT: do NOT strip src/**/*.md or src/**/examples — many bundled skills
# (verify/, claudeApi/, etc.) inline .md files via `import md from './*.md'`
# at runtime through Bun's text loader (see src/skills/bundled/*Content.ts).
rm -f "$CCM_BUNDLE"
(cd "$CLAUDE_CODE_MAIN_DIR" && tar cf "$CCM_BUNDLE" \
  "${NODE_MODULES_EXCLUDES[@]}" \
  package.json bunfig.toml \
  $(ls preload.ts proxy.ts router.ts edgeclaw-config.ts tsconfig.json 2>/dev/null) \
  src/ gateway/ scripts/ node_modules/) \
  || fail "claude-code-main tar creation failed"
CCM_MB=$(du -sm "$CCM_BUNDLE" | awk '{print $1}')
ok "claude-code-main bundle: ${CCM_MB}MB → $(basename "$CCM_BUNDLE")"

# edgeclaw-memory-core bundle: package.json + lib/ (prebuilt JS)
# 注意：claudecodeui/server 和 claude-code-main 都通过 ../../../edgeclaw-memory-core 找它
rm -f "$MEM_BUNDLE"
(cd "$MEMORY_CORE_DIR" && tar cf "$MEM_BUNDLE" \
  --exclude='*.map' --exclude='**/*.md' \
  package.json lib/) \
  || fail "edgeclaw-memory-core tar creation failed"
MEM_MB=$(du -sm "$MEM_BUNDLE" | awk '{print $1}')
ok "edgeclaw-memory-core bundle: ${MEM_MB}MB → $(basename "$MEM_BUNDLE")"

# ============================================================================
step "Compile TypeScript + electron-builder (--dir)"
# ============================================================================

(cd "$DESKTOP_DIR" && npx tsc) || fail "TypeScript compilation failed"
ok "TypeScript compiled (apps/desktop/src → dist/)"

rm -rf "${DESKTOP_DIR}/dist-electron"

EB_ENV=()
[[ "$MODE" == "adhoc" ]] && EB_ENV+=( "CSC_IDENTITY_AUTO_DISCOVERY=false" )
EB_ENV+=( "SKIP_NOTARIZE=1" )

(cd "$DESKTOP_DIR" && env "${EB_ENV[@]}" npx electron-builder --mac --arm64 --dir) \
  || fail "electron-builder failed"
[[ -d "$APP_OUT" ]] || fail "App bundle not produced: ${APP_OUT}"
ok "App built: $(du -sh "$APP_OUT" | awk '{print $1}')"

# ============================================================================
step "Re-sign app bundle"
# ============================================================================

if [[ "$MODE" == "adhoc" ]]; then
  info "ad-hoc deep re-sign…"
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" \
    --options runtime "$APP_OUT" 2>/tmp/edgeclaw-codesign.log \
    || { tail -30 /tmp/edgeclaw-codesign.log; fail "ad-hoc deep sign failed"; }
  codesign --verify --deep --strict "$APP_OUT" 2>/dev/null \
    || fail "ad-hoc signature verification failed"
  ok "ad-hoc signed (Team ID inconsistencies neutralized)"
else
  codesign --verify --deep --strict "$APP_OUT" 2>/dev/null \
    || fail "Code signature verification failed"
  ok "Signature verified"
fi

# ============================================================================
NOTARIZE_OK=0
if [[ "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
step "Apple notarization"
# ============================================================================

  NZ_ZIP="${DESKTOP_DIR}/dist-electron/EdgeClaw-notarize.zip"
  rm -f "$NZ_ZIP"
  ditto -c -k --keepParent "$APP_OUT" "$NZ_ZIP" \
    || fail "Failed to create notarization zip"
  ok "Zip: $(du -sm "$NZ_ZIP" | awk '{print $1}')MB"

  ATTEMPTS=3
  DELAYS=(10 30 60)
  for n in $(seq 1 "$ATTEMPTS"); do
    info "Submitting (attempt ${n}/${ATTEMPTS}, may take 5-20 min)…"
    LOG="$(mktemp)"
    if xcrun notarytool submit "$NZ_ZIP" \
        --keychain-profile "$KEYCHAIN_PROFILE" --wait 2>&1 | tee "$LOG"; then
      if grep -q "status: Accepted" "$LOG"; then
        NOTARIZE_OK=1; rm -f "$LOG"; break
      elif grep -q "status: Invalid" "$LOG"; then
        SID="$(grep -o 'id: [0-9a-f-]*' "$LOG" | head -1 | awk '{print $2}')"
        rm -f "$LOG"
        warn "Apple rejected. Inspect with:"
        echo "      xcrun notarytool log ${SID} --keychain-profile \"${KEYCHAIN_PROFILE}\""
        break
      fi
    fi
    rm -f "$LOG"
    [[ "$n" -lt "$ATTEMPTS" ]] && { warn "Retry in ${DELAYS[$((n-1))]}s…"; sleep "${DELAYS[$((n-1))]}"; }
  done

  if [[ "$NOTARIZE_OK" == "1" ]]; then
    xcrun stapler staple "$APP_OUT" 2>/dev/null && ok "Stapled" || warn "Staple failed"
    SPCTL="$(spctl --assess --type execute --verbose "$APP_OUT" 2>&1 || true)"
    echo "$SPCTL" | grep -q "accepted" && ok "Gatekeeper: accepted" \
      || warn "Gatekeeper not accepted: $SPCTL"
  else
    warn "Notarization failed → producing signed-but-unnotarized DMG (用户需右键→打开)"
  fi
  rm -f "$NZ_ZIP"
fi

# ============================================================================
step "Create APFS DMG"
# ============================================================================

rm -f "$DMG_OUT"
TMP_DMG="$(mktemp -d)"
trap 'rm -rf "$TMP_DMG"' EXIT
ditto "$APP_OUT" "$TMP_DMG/EdgeClaw.app"
ln -s /Applications "$TMP_DMG/Applications"

APP_MB=$(du -sm "$TMP_DMG/EdgeClaw.app" | awk '{print $1}')
ALLOC=$((APP_MB + 200))
info "APFS DMG, allocation=${ALLOC}MB…"
hdiutil create -volname "EdgeClaw" \
  -srcfolder "$TMP_DMG" -ov -fs APFS -format ULMO \
  -size "${ALLOC}m" "$DMG_OUT" >/dev/null 2>&1 \
  || fail "hdiutil create failed"

if [[ "$MODE" == "signed" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG_OUT" >/dev/null 2>&1 \
    && ok "DMG signed" || warn "DMG signing failed (DMG itself, app inside is still valid)"
fi

DMG_MB=$(du -sm "$DMG_OUT" | awk '{print $1}')
ok "DMG: ${DMG_MB}MB → $(basename "$DMG_OUT")"

hdiutil verify "$DMG_OUT" >/dev/null 2>&1 \
  && ok "DMG checksum verified" || warn "DMG verify failed"

# ============================================================================
if [[ "$SKIP_VERIFY" == "0" && -x "${SCRIPT_DIR}/verify-dmg.sh" ]]; then
step "End-to-end verification"
# ============================================================================
  bash "${SCRIPT_DIR}/verify-dmg.sh" "$DMG_OUT" "$MODE" \
    || fail "Verification failed (DMG produced but cannot pass smoke check)"
fi

# ============================================================================
echo
echo "${BLD}${GRN}✓ Release build complete${RST}"
echo
echo "  ${BLD}DMG${RST}      ${DMG_OUT}"
echo "  ${BLD}Version${RST}  ${VERSION}"
echo "  ${BLD}Size${RST}     ${DMG_MB}MB"
echo "  ${BLD}Mode${RST}     ${MODE}"
if [[ "$MODE" == "signed" ]]; then
  echo "  ${BLD}Cert${RST}     ${IDENTITY}"
  if [[ "$NOTARIZE_OK" == "1" ]]; then
    echo "  ${BLD}Notarize${RST} ${GRN}Accepted + Stapled${RST}"
    echo "  ${BLD}Install${RST}  双击 DMG → 拖入 Applications → 双击打开（零摩擦）"
  else
    echo "  ${BLD}Notarize${RST} ${YEL}Skipped/Failed${RST}"
    echo "  ${BLD}Install${RST}  拖入 Applications → 右键打开 → 允许"
  fi
else
  echo "  ${BLD}Install${RST}  ${YEL}本地测试 DMG${RST} · 拖入 Applications → 右键打开"
  echo "  ${BLD}Notice${RST}   ad-hoc 包仅本机有效，分发请用 --signed"
fi
echo
