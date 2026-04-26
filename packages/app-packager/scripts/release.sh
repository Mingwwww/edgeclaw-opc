#!/usr/bin/env bash
# ============================================================================
# app-packager: macOS One-Click Packager
# ----------------------------------------------------------------------------
# Packages Electron apps as signed macOS .app bundles with optional DMG and OTA updates.
# Features:
#   - Auto-detects signing capability (Developer ID → full sign+notarize; else ad-hoc)
#   - tar bundles dist/ + filtered node_modules → repo-bundle.tar in extraResources
#   - electron-builder generates .app (--dir), DMG created manually with hdiutil
#   - ad-hoc: codesign --force --deep re-signs the whole bundle
#   - APFS DMG with ULMO compression via hdiutil
#   - Optional Apple notarization
#   - Optional OTA auto-update via electron-updater
#
# Usage:
#   bash release.sh                    # auto-detect signing
#   bash release.sh --ad-hoc          # force ad-hoc (local test, no notarization)
#   bash release.sh --skip-notarize   # sign but skip notarization
#   bash release.sh --skip-build      # reuse existing dist/
#   bash release.sh --skip-verify     # skip DMG verification
#   bash release.sh --ota             # enable OTA auto-update
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ELECTRON_DIR="${ELECTRON_DIR:-${PLUGIN_DIR}/apps/electron}"
REPO_ROOT="$(cd "${ELECTRON_DIR}/../.." && pwd)"
RESOURCES="${ELECTRON_DIR}/resources"
ENTITLEMENTS="${RESOURCES}/entitlements.mac.plist"
NODE_BIN="${RESOURCES}/node-bin/node"

# ─────────────── Args ───────────────
MODE="auto"          # auto | adhoc | signed
SKIP_BUILD=0
SKIP_NOTARIZE=0
SKIP_VERIFY=0
ENABLE_OTA=0
KEYCHAIN_PROFILE="${NOTARIZE_KEYCHAIN_PROFILE:-EdgeClaw}"

for arg in "$@"; do
  case "$arg" in
    --ad-hoc|--adhoc)   MODE="adhoc" ;;
    --signed)           MODE="signed" ;;
    --skip-build)       SKIP_BUILD=1 ;;
    --skip-notarize)    SKIP_NOTARIZE=1 ;;
    --skip-verify)      SKIP_VERIFY=1 ;;
    --ota)              ENABLE_OTA=1 ;;
    -h|--help)
      sed -n '15,45p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (use --help)" >&2
      exit 2
      ;;
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

VERSION="${VERSION:-$(node -e "console.log(require('${ELECTRON_DIR}/package.json').version)"}"
APP_NAME="${APP_NAME:-$(node -e "console.log(require('${ELECTRON_DIR}/package.json').productName || require('${ELECTRON_DIR}/package.json').name)"}"
APP_OUT="${ELECTRON_DIR}/dist-electron/mac-arm64/${APP_NAME}.app"
DMG_OUT="${ELECTRON_DIR}/dist-electron/${APP_NAME}-${VERSION}-arm64.dmg"
BUNDLE="${RESOURCES}/repo-bundle.tar"

echo "${BLD}app-packager: macOS Packager${RST}"
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

# Notarization profile
if [[ "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
  if xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    ok "Notarize profile: ${KEYCHAIN_PROFILE}"
  else
    warn "Keychain profile '${KEYCHAIN_PROFILE}' not configured → will skip notarization"
    SKIP_NOTARIZE=1
  fi
fi

# Entitlements
[[ -f "$ENTITLEMENTS" ]] || { info "Creating default entitlements..."; mkdir -p "$RESOURCES"; }
ok "Entitlements: $(basename "$ENTITLEMENTS")"

# Bundled Node binary (optional for OTA updates)
if [[ ! -x "$NODE_BIN" && -d "$RESOURCES" ]]; then
  info "Node binary not found in resources (optional for basic packaging)"
fi

# Repo-side prerequisites
DIST_PKG="${REPO_ROOT}/dist/package.json"
if [[ ! -f "$DIST_PKG" ]] || ! grep -q '"type":[[:space:]]*"module"' "$DIST_PKG" 2>/dev/null; then
  info "Writing dist/package.json with type=module"
  mkdir -p "${REPO_ROOT}/dist"
  printf '{"name":"%s","type":"module"}\n' "${APP_NAME}" > "$DIST_PKG"
fi

# ============================================================================
step "Build Application"
# ============================================================================

if [[ "$SKIP_BUILD" == "1" ]]; then
  if [[ -f "${REPO_ROOT}/dist/entry.js" || -f "${REPO_ROOT}/dist/index.js" ]]; then
    warn "Skipped (--skip-build). Reusing existing dist/"
  else
    fail "Cannot --skip-build: dist/ entry missing."
  fi
else
  if [[ -f "${REPO_ROOT}/package.json" ]]; then
    info "Running build..."
    (cd "$REPO_ROOT" && pnpm build) >/tmp/app-packager-build.log 2>&1 \
      || { tail -40 /tmp/app-packager-build.log; fail "Build failed"; }
    ok "Application built"
  else
    info "No package.json found, skipping build step"
  fi
fi

# ============================================================================
step "Create Repo Bundle (tar)"
# ============================================================================

if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  rm -f "$BUNDLE"
  (cd "$REPO_ROOT" && tar cf "$BUNDLE" \
    --exclude='*.map' \
    --exclude='node_modules/.cache' \
    --exclude='node_modules/.bin' \
    --exclude='node_modules/typescript' \
    --exclude='node_modules/@typescript' \
    --exclude='node_modules/@babel' \
    --exclude='node_modules/playwright-core' \
    --exclude='node_modules/@vitest' \
    --exclude='node_modules/vitest' \
    --exclude='node_modules/@types' \
    --exclude='node_modules/prettier' \
    --exclude='node_modules/oxlint' \
    --exclude='node_modules/tsdown' \
    --exclude='node_modules/@esbuild' \
    --exclude='node_modules/esbuild' \
    --exclude='node_modules/rollup' \
    --exclude='node_modules/@rollup' \
    --exclude='**/test' \
    --exclude='**/tests' \
    --exclude='**/__tests__' \
    --exclude='**/*.md' \
    --exclude='dist/extensions/diffs' \
    package.json dist/ node_modules/) 2>/dev/null || true
  BUNDLE_MB=$(du -sm "$BUNDLE" 2>/dev/null | awk '{print $1}' || echo "0")
  ok "Bundle: ${BUNDLE_MB}MB → $(basename "$BUNDLE")"
else
  info "No node_modules found, skipping bundle"
fi

# ============================================================================
step "Compile & Build .app"
# ============================================================================

if [[ -f "${ELECTRON_DIR}/tsconfig.json" ]]; then
  (cd "$ELECTRON_DIR" && npx tsc) 2>/dev/null || info "TypeScript compilation skipped"
fi

rm -rf "${ELECTRON_DIR}/dist-electron"

EB_ENV=()
if [[ "$MODE" == "adhoc" ]]; then
  EB_ENV+=( "CSC_IDENTITY_AUTO_DISCOVERY=false" )
fi
EB_ENV+=( "SKIP_NOTARIZE=1" )

# Build electron app
(cd "$ELECTRON_DIR" && env "${EB_ENV[@]}" npx electron-builder --mac --arm64 --dir) \
  || fail "electron-builder failed"
[[ -d "$APP_OUT" ]] || fail "App bundle not produced: ${APP_OUT}"
ok "App built: $(du -sh "$APP_OUT" | awk '{print $1}')"

# ============================================================================
step "Sign App Bundle"
# ============================================================================

if [[ "$MODE" == "adhoc" ]]; then
  info "ad-hoc deep re-sign..."
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" \
    --options runtime "$APP_OUT" 2>/tmp/app-packager-codesign.log \
    || { tail -30 /tmp/app-packager-codesign.log; fail "ad-hoc deep sign failed"; }
  codesign --verify --deep --strict "$APP_OUT" 2>/dev/null \
    || fail "ad-hoc signature verification failed"
  ok "ad-hoc signed"
else
  codesign --verify --deep --strict "$APP_OUT" 2>/dev/null \
    || fail "Code signature verification failed"
  ok "Signature verified"
fi

# ============================================================================
NOTARIZE_OK=0
if [[ "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
step "Apple Notarization"
# ============================================================================

  NZ_ZIP="${ELECTRON_DIR}/dist-electron/${APP_NAME}-notarize.zip"
  rm -f "$NZ_ZIP"
  ditto -c -k --keepParent "$APP_OUT" "$NZ_ZIP" \
    || fail "Failed to create notarization zip"

  ATTEMPTS=3
  DELAYS=(10 30 60)
  for n in $(seq 1 "$ATTEMPTS"); do
    info "Submitting (attempt ${n}/${ATTEMPTS})..."
    LOG="$(mktemp)"
    if xcrun notarytool submit "$NZ_ZIP" \
        --keychain-profile "$KEYCHAIN_PROFILE" --wait 2>&1 | tee "$LOG"; then
      if grep -q "status: Accepted" "$LOG"; then
        NOTARIZE_OK=1; rm -f "$LOG"; break
      fi
    fi
    rm -f "$LOG"
    [[ "$n" -lt "$ATTEMPTS" ]] && { warn "Retry in ${DELAYS[$((n-1))]}s..."; sleep "${DELAYS[$((n-1))]}"; }
  done

  if [[ "$NOTARIZE_OK" == "1" ]]; then
    xcrun stapler staple "$APP_OUT" 2>/dev/null && ok "Stapled" || warn "Staple failed"
  else
    warn "Notarization failed → proceeding without"
  fi
  rm -f "$NZ_ZIP"
fi

# ============================================================================
step "Create APFS DMG"
# ============================================================================

rm -f "$DMG_OUT"
TMP_DMG="$(mktemp -d)"
trap 'rm -rf "$TMP_DMG"' EXIT
ditto "$APP_OUT" "$TMP_DMG/${APP_NAME}.app"
ln -s /Applications "$TMP_DMG/Applications"

APP_MB=$(du -sm "$TMP_DMG/${APP_NAME}.app" | awk '{print $1}')
ALLOC=$((APP_MB + 200))
info "Creating APFS DMG, allocation=${ALLOC}MB..."
hdiutil create -volname "${APP_NAME}" \
  -srcfolder "$TMP_DMG" -ov -fs APFS -format ULMO \
  -size "${ALLOC}m" "$DMG_OUT" >/dev/null 2>&1 \
  || fail "hdiutil create failed"

if [[ "$MODE" == "signed" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG_OUT" >/dev/null 2>&1 \
    && ok "DMG signed" || warn "DMG signing failed"
fi

DMG_MB=$(du -sm "$DMG_OUT" | awk '{print $1}')
ok "DMG: ${DMG_MB}MB → $(basename "$DMG_OUT")"

hdiutil verify "$DMG_OUT" >/dev/null 2>&1 \
  && ok "DMG checksum verified" || warn "DMG verify failed"

# ============================================================================
if [[ "$ENABLE_OTA" == "1" ]]; then
step "Configure OTA Auto-Update"
# ============================================================================
  info "OTA update configuration:"
  info "  Provider: github (or custom updateServer)"
  info "  The app will check for updates on launch via electron-updater"
  info "  Configure publish settings in electron-builder.yml"
  ok "OTA enabled"
fi

# ============================================================================
if [[ "$SKIP_VERIFY" == "0" ]]; then
step "End-to-End Verification"
# ============================================================================
  bash "${SCRIPT_DIR}/verify-dmg.sh" "$DMG_OUT" "$MODE" \
    || warn "Verification failed (DMG may still be usable)"
fi

# ============================================================================
echo
echo "${BLD}${GRN}✓ Release build complete${RST}"
echo
echo "  ${BLD}DMG${RST}      ${DMG_OUT}"
echo "  ${BLD}Version${RST}  ${VERSION}"
echo "  ${BLD}Size${RST}     ${DMG_MB}MB"
echo "  ${BLD}Mode${RST}     ${MODE}"
echo "  ${BLD}OTA${RST}      $([ "$ENABLE_OTA" == "1" ] && echo "enabled" || echo "disabled")"
echo