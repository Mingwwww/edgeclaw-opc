---
name: dmg
description: Create APFS DMG from .app bundle
when_to_use: "Use when you need a DMG installer for distribution."
---

# DMG: Create macOS DMG

Creates an APFS DMG installer from an .app bundle.

## Pre-flight

1. Verify .app exists:
   ```bash
   ls -la dist-electron/mac-arm64/*.app
   ```

2. Check hdiutil availability:
   ```bash
   hdiutil info
   ```

## Execution

```bash
APP_PATH="/path/to/App.app"
DMG_PATH="/path/to/output.dmg"
VOLUME_NAME="AppName"
SIZE_MB=$(du -sm "$APP_PATH" | awk '{print $1}')
ALLOC=$((SIZE_MB + 200))

# Create DMG
hdiutil create -volname "$VOLUME_NAME" \
  -srcfolder "$(dirname "$APP_PATH")" \
  -ov -fs APFS -format ULMO \
  -size "${ALLOC}m" "$DMG_PATH"

# Sign DMG (optional)
codesign --force --sign "Developer ID Application: Name (TEAMID)" \
  --timestamp "$DMG_PATH"

# Verify DMG
hdiutil verify "$DMG_PATH"
```

## DMG Structure

The DMG includes:
- `App.app` - The application
- `Applications` symlink - Standard macOS installation target

## Notes

- Uses APFS for better compression
- ULMO format for maximum size reduction
- Allocation includes 200MB buffer above app size