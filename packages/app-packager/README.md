# app-packager

Claude Code plugin for packaging Electron apps as macOS App bundles with OTA auto-update support.

## Features

- **Auto-detect signing**: Developer ID for notarized builds, ad-hoc for local testing
- **tar bundle**: Optimized node_modules packaging via `repo-bundle.tar`
- **electron-builder**: Builds `.app` bundle (arm64/x64/universal)
- **hdiutil DMG**: APFS-formatted DMG with ULMO compression
- **Apple notarization**: Full notarization workflow with stapling
- **OTA updates**: Built-in electron-updater integration

## Skills

| Skill | Description |
|-------|-------------|
| `release` | Full release pipeline (build → sign → notarize → DMG → OTA) |
| `pack` | Build `.app` bundle only |
| `sign` | Code sign with Developer ID or ad-hoc |
| `dmg` | Create APFS DMG from `.app` |
| `verify` | Verify DMG integrity and signature |

## Usage

```bash
# Full release with notarization
/repo:release

# Ad-hoc local build
/repo:release --ad-hoc

# With OTA auto-update
/repo:release --ota

# Skip notarization
/repo:release --skip-notarize
```

## Configuration

### electron-builder.yml

```yaml
appId: com.yourcompany.yourapp
productName: YourApp
mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
  hardenedRuntime: true
  gatekeeperAssessment: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.plist
publish:
  provider: github
  owner: your-org
  repo: your-repo
```

### OTA Setup

1. Add `electron-updater` to dependencies:
   ```bash
   pnpm add electron-updater
   ```

2. Integrate in main process:
   ```javascript
   const { autoUpdater } = require('electron-updater');

   if (app.isPackaged) {
     autoUpdater.checkForUpdates();
   }
   ```

3. Configure GitHub releases for publishing updates.

## Reference

Based on EdgeClaw's macOS packager at `~/ws/edgeclaw-ccrush/EdgeClaw/apps/electron/scripts/release.sh`