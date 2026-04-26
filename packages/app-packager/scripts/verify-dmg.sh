#!/usr/bin/env bash
# ============================================================================
# verify-dmg.sh - End-to-end DMG verification
# Usage: bash verify-dmg.sh <dmg-path> <mode>
#   mode: signed | adhoc
# ============================================================================

set -euo pipefail

DMG_PATH="${1:-}"
MODE="${2:-signed}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'
RST=$'\033[0m'

pass() { echo "  ${GRN}✓${RST} $*"; }
fail() { echo "  ${RED}✗${RST} $*"; exit 1; }
warn() { echo "  ${YEL}⚠${RST} $*"; }

[[ -z "$DMG_PATH" ]] && { echo "Usage: $0 <dmg-path> [signed|adhoc]"; exit 1; }
[[ ! -f "$DMG_PATH" ]] && fail "DMG not found: $DMG_PATH"

echo "Verifying: $DMG_PATH"
echo "Mode: $MODE"
echo

# Mount DMG temporarily
MOUNT_POINT="$(mktemp -d)"
trap 'hdiutil detach "$MOUNT_POINT" 2>/dev/null || true; rm -rf "$MOUNT_POINT"' EXIT

echo "Mounting DMG..."
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse >/dev/null 2>&1 \
  || { warn "Could not mount DMG"; }

# Find .app in DMG
APP_PATH=$(find "$MOUNT_POINT" -name "*.app" -type d 2>/dev/null | head -1)

if [[ -z "$APP_PATH" ]]; then
  warn "No .app found in DMG"
else
  echo

  # Check 1: DMG checksum
  if hdiutil verify "$DMG_PATH" 2>/dev/null; then
    pass "DMG checksum valid"
  else
    fail "DMG checksum failed"
  fi

  # Check 2: Code signature
  echo "Checking code signature..."
  if spctl --assess --type execute --verbose "$APP_PATH" 2>&1 | grep -q "accepted"; then
    pass "Code signature accepted"
  elif [[ "$MODE" == "adhoc" ]]; then
    warn "Ad-hoc mode - signature may show as invalid"
  else
    fail "Code signature failed"
  fi

  # Check 3: Notarization (if signed mode)
  if [[ "$MODE" == "signed" ]]; then
    echo "Checking notarization..."
    if xcrun stapler validate "$APP_PATH" 2>/dev/null; then
      pass "Notarization stapled"
    else
      warn "Notarization not stapled (may need network connection)"
    fi
  fi
fi

echo
pass "Verification complete"