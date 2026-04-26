---
name: release
description: Full macOS release pipeline - build, sign, notarize, DMG, OTA update
when_to_use: "Use when releasing an Electron app as a macOS .app or DMG with OTA auto-update support."
---

# Release: Full macOS Release Pipeline

This skill runs the complete macOS release pipeline for Electron apps.

## Pre-flight

1. Detect project structure:
   - Find `apps/electron/` or `electron/` directory
   - Read `package.json` for app name and version
   - Check for `resources/entitlements.mac.plist`

2. Check signing availability:
   ```bash
   security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID"
   ```

## Execution

Run the release script with appropriate flags:

```bash
# Full release with notarization
bash scripts/release.sh

# Ad-hoc (local testing only)
bash scripts/release.sh --ad-hoc

# Skip notarization (sign but don't notarize)
bash scripts/release.sh --skip-notarize

# Skip build (use existing dist/)
bash scripts/release.sh --skip-build

# Enable OTA auto-update
bash scripts/release.sh --ota
```

## Output

- `.app` bundle at `dist-electron/mac-arm64/{AppName}.app`
- DMG at `dist-electron/{AppName}-{version}-arm64.dmg`
- OTA update configuration (if enabled)

## Sign-off Criteria

- DMG created and verified
- Signature valid (ad-hoc or Developer ID)
- Notarization accepted (if signed mode)
- App launches without Gatekeeper errors