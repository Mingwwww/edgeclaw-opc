---
name: verify
description: Verify DMG integrity and code signature
when_to_use: "Use after creating a DMG to ensure it's valid and properly signed."
---

# Verify: DMG Integrity Check

Verifies DMG integrity, code signature, and Gatekeeper acceptance.

## Checks

1. **DMG Checksum** - Verify DMG is not corrupted
2. **Code Signature** - Verify .app is properly signed
3. **Notarization** - Verify Apple notarization (if applicable)
4. **Gatekeeper** - Verify app passes Gatekeeper assessment

## Execution

```bash
# Full verification
bash scripts/verify-dmg.sh /path/to/app.dmg signed

# Quick DMG check only
hdiutil verify /path/to/app.dmg

# Signature check
codesign --verify --deep --strict /path/to/App.app
spctl --assess --type execute --verbose /path/to/App.app

# Notarization check
xcrun stapler validate /path/to/App.app
```

## Exit Codes

- `0` - All checks passed
- `1` - Verification failed

## Output

```
✓ DMG checksum verified
✓ Code signature valid
✓ Notarization accepted (stapled)
✓ Gatekeeper: accepted
```