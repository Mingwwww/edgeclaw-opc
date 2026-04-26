---
name: pack
description: Build Electron app as .app bundle using electron-builder
when_to_use: "Use when you need to create a macOS .app bundle without full release pipeline."
---

# Pack: Build .app Bundle

Builds an Electron app as a macOS application bundle.

## Pre-flight

1. Verify Electron project:
   ```bash
   ls apps/electron/package.json 2>/dev/null || ls electron/package.json 2>/dev/null
   ```

2. Check electron-builder is available:
   ```bash
   npx electron-builder --version
   ```

## Execution

```bash
# Build .app for current architecture
cd apps/electron
npx electron-builder --mac --dir

# Build for specific architecture
npx electron-builder --mac --arm64 --dir
npx electron-builder --mac --x64 --dir
```

## Output

- `.app` bundle in `dist-electron/mac-{arch}/{AppName}.app`

## Options

- `--dir` - Only build .app, skip DMG creation
- `--arm64` - Apple Silicon build
- `--x64` - Intel build
- `--universal` - Both architectures