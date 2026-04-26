---
name: sign
description: Code sign macOS app bundle (Developer ID or ad-hoc)
when_to_use: "Use when signing is needed for local testing or distribution."
---

# Sign: Code Signing

Handles macOS code signing for Electron app bundles.

## Signing Modes

### Auto (Default)
Detects Developer ID certificate; falls back to ad-hoc if not found.

### Developer ID (Signed)
Full signing for App Store distribution and notarization.

### Ad-hoc
Local testing only; app will show Gatekeeper warning.

## Pre-flight

Check available certificates:
```bash
security find-identity -p codesigning -v
```

## Execution

```bash
# Ad-hoc sign
codesign --force --deep --sign - --entitlements resources/entitlements.mac.plist \
  --options runtime "/path/to/App.app"

# Developer ID sign
codesign --force --deep --sign "Developer ID Application: Name (TEAMID)" \
  --entitlements resources/entitlements.mac.plist \
  --options runtime "/path/to/App.app"

# Verify signature
codesign --verify --deep --strict "/path/to/App.app"
```

## Entitlements

Standard entitlements for Electron:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```