#!/usr/bin/env bash
# ============================================================================
# EdgeClaw Desktop macOS One-Click Packager (release.sh)
# ----------------------------------------------------------------------------
# 完整发版流程见 apps/desktop/RELEASING.md（如何 bump 版本号 / 何时打 tag /
# 何时合 main / 如何写 CHANGELOG）。本脚本只负责"把当前 commit 打成 DMG"。
#
# Usage:
#   bash scripts/release.sh                 # auto: signed if cert in keychain, else ad-hoc
#   bash scripts/release.sh --ad-hoc        # force ad-hoc (local test)
#   bash scripts/release.sh --signed        # require Developer ID; fail if missing
#   bash scripts/release.sh --skip-notarize # signed but no notarization
#   bash scripts/release.sh --skip-build    # reuse existing claudecodeui/dist
#   bash scripts/release.sh --skip-verify   # skip post-build verification
#   bash scripts/release.sh --skip-publish  # skip GitHub Release upload
#
# Environment overrides (escape hatches — see RELEASING.md for context):
#   ALLOW_UNTAGGED=1         # skip "git tag must match version" pre-flight check
#                            # (only useful with --ad-hoc; signed builds should be tagged)
#   ALLOW_NON_MAIN_SIGNED=1  # allow --signed from a non-main branch (hotfix scenarios)
#   SKIP_PUBLISH=1           # same as --skip-publish (env override)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
RESOURCES="${DESKTOP_DIR}/resources"
ENTITLEMENTS="${RESOURCES}/entitlements.mac.plist"
NODE_BIN="${RESOURCES}/node-bin/node"
BUN_BIN="${RESOURCES}/bun-bin/bun"

# Source tree path: this repo names the UI dir `ui/`; spike originally used
# `claudecodeui/`. Bundle filename + extracted runtime dir name remain
# `claudecodeui` because server-manager.ts / electron-builder.yml hardcode it.
CLAUDECODEUI_DIR="${REPO_ROOT}/ui"
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
SKIP_PUBLISH="${SKIP_PUBLISH:-0}"
KEYCHAIN_PROFILE="${NOTARIZE_KEYCHAIN_PROFILE:-EdgeClaw}"
KEYCHAIN_PATH="${NOTARIZE_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
KEYCHAIN_ARGS=()  # resolved in pre-flight after probing both keychains

for arg in "$@"; do
  case "$arg" in
    --ad-hoc|--adhoc) MODE="adhoc" ;;
    --signed)         MODE="signed" ;;
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-notarize)  SKIP_NOTARIZE=1 ;;
    --skip-verify)    SKIP_VERIFY=1 ;;
    --skip-publish)   SKIP_PUBLISH=1 ;;
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

# ─────────────── Git provenance (tag + branch + sha) ───────────────
# Why this lives in pre-flight: a built DMG without a corresponding git tag is
# untraceable — when a user reports a bug, you can't reliably check out the
# code that built their binary. We refuse to ship that by default. See
# RELEASING.md for the full rationale and escape hatches.
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_FULL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
BUILD_DATE="$(date -u +%Y-%m-%d)"
EXPECTED_TAG="v${VERSION}"

if [[ "$GIT_SHA" == "unknown" ]]; then
  warn "Not a git checkout — skipping tag/branch checks (build-info will say 'unknown')"
else
  # Tag check
  if git -C "$REPO_ROOT" rev-parse "$EXPECTED_TAG" >/dev/null 2>&1; then
    TAG_SHA="$(git -C "$REPO_ROOT" rev-parse "${EXPECTED_TAG}^{commit}" 2>/dev/null || echo "")"
    if [[ "$TAG_SHA" != "$GIT_FULL_SHA" ]]; then
      if [[ "${ALLOW_UNTAGGED:-0}" != "1" ]]; then
        fail "git tag '${EXPECTED_TAG}' points to ${TAG_SHA:0:7}, but HEAD is ${GIT_SHA}.
    Either checkout the tagged commit, or re-tag: git tag -f ${EXPECTED_TAG}
    Or set ALLOW_UNTAGGED=1 (only sane for --ad-hoc)."
      fi
      warn "tag '${EXPECTED_TAG}' points to ${TAG_SHA:0:7} ≠ HEAD ${GIT_SHA} (ALLOW_UNTAGGED=1)"
    else
      ok "git tag: ${EXPECTED_TAG} → HEAD (${GIT_SHA})"
    fi
  else
    if [[ "${ALLOW_UNTAGGED:-0}" != "1" ]]; then
      fail "No git tag '${EXPECTED_TAG}' for version ${VERSION}.
    先跑: (cd apps/desktop && npm version patch -m 'release(desktop): v%s')
    本地测试可加: ALLOW_UNTAGGED=1 bash scripts/release.sh --ad-hoc
    完整流程见: apps/desktop/RELEASING.md"
    fi
    warn "No git tag '${EXPECTED_TAG}' (ALLOW_UNTAGGED=1)"
  fi

  # Branch check (signed-only)
  if [[ "$MODE" == "signed" && "$GIT_BRANCH" != "main" && "$GIT_BRANCH" != "master" ]]; then
    if [[ "${ALLOW_NON_MAIN_SIGNED:-0}" != "1" ]]; then
      fail "release(--signed) requires main/master branch (current: ${GIT_BRANCH}).
    内部测试请用: bash scripts/release.sh --ad-hoc
    正式发版请: git checkout main && git merge --ff-only ${GIT_BRANCH}
    Hotfix 强制覆盖: ALLOW_NON_MAIN_SIGNED=1 bash scripts/release.sh --signed"
    fi
    warn "signed build from non-main branch '${GIT_BRANCH}' (ALLOW_NON_MAIN_SIGNED=1)"
  else
    ok "Branch: ${GIT_BRANCH}   ·   Build date: ${BUILD_DATE}"
  fi
fi

if [[ "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
  # Probe keychains: prefer login.keychain-db (stable), fallback to Data
  # Protection Keychain (iCloud Keychain — works but locks intermittently).
  if [[ -f "$KEYCHAIN_PATH" ]] \
     && xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" \
          --keychain "$KEYCHAIN_PATH" >/dev/null 2>&1; then
    KEYCHAIN_ARGS=(--keychain-profile "$KEYCHAIN_PROFILE" --keychain "$KEYCHAIN_PATH")
    ok "Notarize profile: ${KEYCHAIN_PROFILE} (login.keychain-db — stable)"
  elif xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    KEYCHAIN_ARGS=(--keychain-profile "$KEYCHAIN_PROFILE")
    ok "Notarize profile: ${KEYCHAIN_PROFILE} (Data Protection Keychain — may lock)"
    warn "For reliability, migrate credentials to login.keychain-db:"
    warn "  xcrun notarytool store-credentials \"${KEYCHAIN_PROFILE}\" \\"
    warn "    --apple-id <email> --team-id ${TEAM_ID:-XXXXXXXXXX} --password <app-pwd> \\"
    warn "    --keychain ~/Library/Keychains/login.keychain-db"
  else
    warn "Keychain profile '${KEYCHAIN_PROFILE}' not found in any keychain → skipping notarization"
    warn "Configure with: xcrun notarytool store-credentials \"${KEYCHAIN_PROFILE}\" \\"
    warn "    --apple-id <email> --team-id ${TEAM_ID:-XXXXXXXXXX} --password <app-specific-pwd> \\"
    warn "    --keychain ~/Library/Keychains/login.keychain-db"
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
step "Emit build-info.json"
# ============================================================================
# Goes into apps/desktop/dist/ alongside main.js — electron-builder's
# `files: dist/**/*` rule picks it up automatically. Read at startup by
# main.ts and exposed to renderer via window.edgeclaw.getBuildInfo().
mkdir -p "${DESKTOP_DIR}/dist"
cat > "${DESKTOP_DIR}/dist/build-info.json" <<EOF
{
  "version": "${VERSION}",
  "gitSha": "${GIT_SHA}",
  "gitFullSha": "${GIT_FULL_SHA}",
  "gitBranch": "${GIT_BRANCH}",
  "buildDate": "${BUILD_DATE}",
  "mode": "${MODE}"
}
EOF
ok "build-info.json: v${VERSION} (${GIT_SHA}) @ ${BUILD_DATE} [${MODE}]"

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

# edgeclaw-memory-core bundle: package.json + lib/ (prebuilt JS) + ui-source/
# (UI dashboard served by claudecodeui /memory-dashboard route — without it the
#  iframe falls through to the SPA index and recursively renders the whole app).
# 注意：claudecodeui/server 和 claude-code-main 都通过 ../../../edgeclaw-memory-core 找它
rm -f "$MEM_BUNDLE"
[[ -f "${MEMORY_CORE_DIR}/ui-source/index.html" ]] \
  || fail "edgeclaw-memory-core/ui-source/index.html missing — required for /memory-dashboard"
(cd "$MEMORY_CORE_DIR" && tar cf "$MEM_BUNDLE" \
  --exclude='*.map' --exclude='**/*.md' \
  package.json lib/ ui-source/) \
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

  # Retry delays are tuned for Apple notary throttling, which empirically
  # requires 5-15 min cooldown after rapid successive submissions.
  # Worst-case extra wait: 60+180+600 = 14 min — acceptable inside a release
  # that already takes ~10 min when notarize succeeds first try.
  ATTEMPTS=3
  DELAYS=(60 180 600)
  for n in $(seq 1 "$ATTEMPTS"); do
    info "Submitting (attempt ${n}/${ATTEMPTS}, may take 5-20 min)…"
    LOG="$(mktemp)"
    if xcrun notarytool submit "$NZ_ZIP" \
        "${KEYCHAIN_ARGS[@]}" --wait 2>&1 | tee "$LOG"; then
      if grep -q "status: Accepted" "$LOG"; then
        NOTARIZE_OK=1; rm -f "$LOG"; break
      elif grep -q "status: Invalid" "$LOG"; then
        SID="$(grep -o 'id: [0-9a-f-]*' "$LOG" | head -1 | awk '{print $2}')"
        rm -f "$LOG"
        warn "Apple rejected. Inspect with:"
        echo "      xcrun notarytool log ${SID} ${KEYCHAIN_ARGS[*]}"
        break
      fi
    fi
    # Notarytool diagnostic: distinguish throttling from real auth failure.
    # Pre-flight already validated the profile — so 'No Keychain password
    # item found' here is almost always Apple notary returning an opaque
    # auth-fail (typically rate-limited after 4-5 rapid submissions/hour).
    # Real profile/credential issues would have failed pre-flight.
    if grep -q "No Keychain password item found" "$LOG" 2>/dev/null; then
      warn "↳ Diagnostic: 'No Keychain password item found' but profile validated in pre-flight."
      warn "  Almost certainly Apple notary throttling (not a credential problem)."
      warn "  Cooldown is typically 5-15 min after 4-5 rapid submissions per hour."
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
step "Create DMG"
# ============================================================================
# We use a manual mount→ditto→detach→convert pipeline instead of
# `hdiutil create -srcfolder` because on macOS 14+ the latter triggers App
# Management TCC denial when copying a notarized .app via hdiutil's internal
# ditto step (error: "操作不被允许" / EPERM on /Volumes/<volname>/<App>.app).
#
# CRITICAL — volume name TCC heuristic (verified empirically on macOS 14.x):
#   • "EdgeClaw"          → blocked (matches CFBundleName)
#   • "EdgeClaw 0.1.0"    → blocked (CFBundleName + space + token)
#   • "EdgeClaw Installer"→ OK
#   • "Install EdgeClaw"  → was OK on older macOS; on darwin 25+ the form
#     "Install EdgeClaw 0.1.0" (version suffix) triggers ditto EPERM — avoid.
#   • "EdgeClaw-0.1.0" / "EdgeClaw-0.1.0-Installer" → OK (hyphenated forms)
# The pattern appears to be: TCC App Management blocks copying a notarized
# .app into a volume whose name matches certain "app-like" titles. Safer to
# use a hyphenated volname that cannot be read as "<BrandName> <semver>".
#
# Other learned constraints:
#   • Format ULMO/APFS combo breaks; HFS+ + UDZO is universally portable.
#   • Manual ditto is required because `hdiutil create -srcfolder` runs
#     ditto internally with the same TCC restrictions.
#   • Stripping `com.apple.provenance` xattr is NOT required if volname
#     avoids the trigger pattern.

rm -f "$DMG_OUT"

APP_MB=$(du -sm "$APP_OUT" | awk '{print $1}')
ALLOC=$((APP_MB + 300))
VOLNAME="EdgeClaw-${VERSION}-Installer"
RW_DMG="$(mktemp -t edgeclaw-rw.XXXX).dmg"
trap 'rm -f "$RW_DMG"; mount | awk -v v="$VOLNAME" "\$0 ~ v {print \$1}" | xargs -I{} hdiutil detach {} -force >/dev/null 2>&1 || true' EXIT

info "Step a: create empty UDRW image (${ALLOC}MB, HFS+, volname='${VOLNAME}')…"
hdiutil create -size "${ALLOC}m" -fs HFS+ -volname "$VOLNAME" \
  -layout SPUD -ov "$RW_DMG" >/dev/null 2>&1 \
  || fail "Failed to create empty DMG"

info "Step b: attach…"
ATT_PLIST="$(hdiutil attach -plist -nobrowse -noverify -noautoopen "$RW_DMG")" \
  || fail "hdiutil attach failed"
MP="$(echo "$ATT_PLIST" | python3 -c "import sys, plistlib; d=plistlib.loads(sys.stdin.buffer.read()); print(next((e['mount-point'] for e in d['system-entities'] if 'mount-point' in e), ''))")"
[[ -n "$MP" && -d "$MP" ]] || fail "Could not parse mount point from hdiutil plist"

info "Step c: ditto .app + Applications symlink…"
ditto "$APP_OUT" "$MP/EdgeClaw.app" \
  || { hdiutil detach "$MP" -force >/dev/null 2>&1; fail "ditto into mounted DMG failed (TCC? try a different volname)"; }
ln -sf /Applications "$MP/Applications"

info "Step d: detach…"
hdiutil detach "$MP" -force >/dev/null 2>&1 || warn "detach reported non-zero (often safe)"

info "Step e: convert to UDZO compressed…"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null 2>&1 \
  || fail "hdiutil convert failed"
rm -f "$RW_DMG"

if [[ "$MODE" == "signed" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG_OUT" >/dev/null 2>&1 \
    && ok "DMG signed" || warn "DMG signing failed (DMG itself, app inside is still valid)"
fi

DMG_MB=$(du -sm "$DMG_OUT" | awk '{print $1}')
ok "DMG: ${DMG_MB}MB → $(basename "$DMG_OUT")"

hdiutil verify "$DMG_OUT" >/dev/null 2>&1 \
  && ok "DMG checksum verified" || warn "DMG verify failed"

# ============================================================================
# DMG-level notarization (offline-friendly polish).
#
# The .app inside is already notarized + stapled, so installed users will
# always pass Gatekeeper. This step adds a separate ticket on the DMG
# *envelope* itself — without it, a user double-clicking the DMG while
# completely offline sees a one-time "cannot verify developer" dialog
# before they can mount it. Stapling the DMG embeds the ticket so even
# offline mounts are silent.
#
# Behavior:
#   • Skipped if .app notarize was skipped or failed (DMG would also fail).
#   • Single attempt (no retry): worst case the user sees the one-time
#     dialog, which is harmless — the inner .app still verifies correctly.
#   • Submission size ≈ DMG size (~385MB), takes ~1-3 min typically.
DMG_NOTARIZE_OK=0
if [[ "$NOTARIZE_OK" == "1" && "$MODE" == "signed" && "$SKIP_NOTARIZE" == "0" ]]; then
step "Notarize DMG (offline-friendly polish)"
# ============================================================================
  info "Submitting DMG envelope (1-3 min typically)…"
  DMG_LOG="$(mktemp)"
  if xcrun notarytool submit "$DMG_OUT" \
      "${KEYCHAIN_ARGS[@]}" --wait 2>&1 | tee "$DMG_LOG"; then
    if grep -q "status: Accepted" "$DMG_LOG"; then
      DMG_NOTARIZE_OK=1
    fi
  fi
  if [[ "$DMG_NOTARIZE_OK" == "1" ]]; then
    if xcrun stapler staple "$DMG_OUT" >/dev/null 2>&1; then
      ok "DMG stapled (offline mount is silent — no first-open dialog)"
    else
      warn "DMG stapler failed (.app inside still notarized — users will see"
      warn "  one-time dialog on offline mount, then it's silent forever)"
    fi
  else
    if grep -q "No Keychain password item found" "$DMG_LOG" 2>/dev/null; then
      warn "DMG-level notarize hit keychain lock (.app inside still notarized)"
      warn "  See RELEASING.md 'Apple Notarization 钥匙串问题' for permanent fix"
    else
      warn "DMG-level notarize failed (.app inside still notarized — non-fatal)"
    fi
    info "  (Run later: xcrun notarytool submit \"$DMG_OUT\" ${KEYCHAIN_ARGS[*]} --wait)"
    info "  (Then:      xcrun stapler staple \"$DMG_OUT\")"
  fi
  rm -f "$DMG_LOG"
fi

# ============================================================================
# Ship the install/repair helper alongside the DMG so recipients who got the
# DMG via a sandboxed IM (Lark/WeChat/QQ/DingTalk) can self-recover without
# us walking them through `xattr -cr` over chat.
#
# The helper is also useful for: unstapled .app diagnosis, Gatekeeper
# rejection diagnosis, and showing "Authority + source" of an installed
# build. See INSTALL.md for the user-facing explanation.
DIST_DIR="$(dirname "$DMG_OUT")"
HELPER_SRC="${SCRIPT_DIR}/install-edgeclaw.sh"
HELPER_DST="${DIST_DIR}/install-edgeclaw.sh"
INSTALL_MD_SRC="${DESKTOP_DIR}/INSTALL.md"
INSTALL_MD_DST="${DIST_DIR}/INSTALL.md"
if [[ -f "$HELPER_SRC" ]]; then
  cp "$HELPER_SRC" "$HELPER_DST" && chmod +x "$HELPER_DST" \
    && ok "Install helper: $(basename "$HELPER_DST")"
fi
if [[ -f "$INSTALL_MD_SRC" ]]; then
  cp "$INSTALL_MD_SRC" "$INSTALL_MD_DST" \
    && ok "Install guide: $(basename "$INSTALL_MD_DST")"
fi

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
[[ -f "$HELPER_DST" ]]    && echo "  ${BLD}Helper${RST}   ${HELPER_DST}"
[[ -f "$INSTALL_MD_DST" ]] && echo "  ${BLD}Guide${RST}    ${INSTALL_MD_DST}"
echo "  ${BLD}Version${RST}  ${VERSION}"
echo "  ${BLD}Build${RST}    ${GIT_SHA} · ${BUILD_DATE} · branch=${GIT_BRANCH}"
echo "  ${BLD}Size${RST}     ${DMG_MB}MB"
echo "  ${BLD}Mode${RST}     ${MODE}"
if [[ "$MODE" == "signed" ]]; then
  echo "  ${BLD}Cert${RST}     ${IDENTITY}"
  if [[ "$NOTARIZE_OK" == "1" ]]; then
    if [[ "$DMG_NOTARIZE_OK" == "1" ]]; then
      echo "  ${BLD}Notarize${RST} ${GRN}.app + DMG both stapled (fully offline-friendly)${RST}"
      echo "  ${BLD}Install${RST}  双击 DMG → 拖入 Applications → 双击打开（零摩擦，离线也行）"
    else
      echo "  ${BLD}Notarize${RST} ${GRN}.app stapled${RST} · ${YEL}DMG envelope not stapled${RST}"
      echo "  ${BLD}Install${RST}  双击 DMG → 拖入 Applications → 双击打开（联网零摩擦；"
      echo "                  完全离线时首次双击 DMG 会有一次性提示，按"打开"放行）"
    fi
    echo
    echo "  ${BLD}${YEL}分发提示${RST}  通过飞书/微信/QQ 等沙盒 IM 发 DMG 会触发"
    echo "          macOS provenance 拒绝执行（详见 INSTALL.md 根因分析）。"
    echo "          推荐：浏览器直链 / AirDrop / GitHub Releases。"
    echo "          兜底：把 install-edgeclaw.sh 一并发送，让收方跑一次即可。"
  else
    echo "  ${BLD}Notarize${RST} ${YEL}Skipped/Failed${RST}"
    echo "  ${BLD}Install${RST}  拖入 Applications → 右键打开 → 允许"
  fi
else
  echo "  ${BLD}Install${RST}  ${YEL}本地测试 DMG${RST} · 拖入 Applications → 右键打开"
  echo "  ${BLD}Notice${RST}   ad-hoc 包仅本机有效，分发请用 --signed"
fi
echo

# ============================================================================
# [12] Publish to GitHub Releases
# ============================================================================
GH_PUBLISH_OK=0
if [[ "$SKIP_PUBLISH" == "1" ]]; then
  info "GitHub Release upload skipped (--skip-publish)"
elif [[ "$MODE" == "adhoc" ]]; then
  info "GitHub Release upload skipped (ad-hoc builds are not published)"
elif ! command -v gh &>/dev/null; then
  warn "gh CLI not found — skipping GitHub Release upload"
  warn "  Install: brew install gh && gh auth login"
elif ! gh auth status &>/dev/null 2>&1; then
  warn "gh CLI not authenticated — skipping GitHub Release upload"
  warn "  Run: gh auth login"
else
  step "Publish to GitHub Releases"

  GH_TAG="v${VERSION}"
  CHANGELOG_FILE="${REPO_ROOT}/CHANGELOG.md"
  GH_NOTES=""

  # Extract release notes from CHANGELOG.md for this version
  if [[ -f "$CHANGELOG_FILE" ]]; then
    GH_NOTES="$(awk -v ver="## v${VERSION}" '
      $0 ~ ver { found=1; next }
      found && /^---$/ { exit }
      found && /^## v/ { exit }
      found { print }
    ' "$CHANGELOG_FILE" | sed '/^$/{ N; /^\n$/d; }' | sed -e '/./,$!d' -e :a -e '/^\n*$/{$d;N;ba' -e '}')"
  fi

  if [[ -z "$GH_NOTES" ]]; then
    GH_NOTES="EdgeClaw Desktop ${GH_TAG}

Build: ${GIT_SHA} · ${BUILD_DATE} · branch=${GIT_BRANCH}
Mode: ${MODE}"
  fi

  # Collect assets to upload
  GH_ASSETS=("$DMG_OUT")
  [[ -f "$HELPER_DST" ]]     && GH_ASSETS+=("$HELPER_DST")
  [[ -f "$INSTALL_MD_DST" ]] && GH_ASSETS+=("$INSTALL_MD_DST")

  # Create or update the release
  if gh release view "$GH_TAG" --repo "$(git -C "$REPO_ROOT" remote get-url origin)" &>/dev/null 2>&1; then
    info "Release ${GH_TAG} exists — uploading assets (overwrite)…"
    gh release upload "$GH_TAG" "${GH_ASSETS[@]}" --clobber \
      --repo "$(git -C "$REPO_ROOT" remote get-url origin)" \
      && { ok "Assets uploaded to existing release ${GH_TAG}"; GH_PUBLISH_OK=1; } \
      || warn "Failed to upload assets to ${GH_TAG} (non-fatal)"
  else
    info "Creating release ${GH_TAG}…"
    gh release create "$GH_TAG" "${GH_ASSETS[@]}" \
      --repo "$(git -C "$REPO_ROOT" remote get-url origin)" \
      --title "EdgeClaw Desktop ${GH_TAG}" \
      --notes "$GH_NOTES" \
      && { ok "Release ${GH_TAG} created with assets"; GH_PUBLISH_OK=1; } \
      || warn "Failed to create release ${GH_TAG} (non-fatal)"
  fi

  if [[ "$GH_PUBLISH_OK" == "1" ]]; then
    GH_URL="$(gh release view "$GH_TAG" --repo "$(git -C "$REPO_ROOT" remote get-url origin)" --json url -q .url 2>/dev/null || true)"
    [[ -n "$GH_URL" ]] && echo "  ${BLD}Release${RST}  ${GH_URL}"
  fi
fi
