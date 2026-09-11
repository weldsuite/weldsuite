# WeldMail, App Store / Play Store

This directory holds store listing copy and marketing screenshots for WeldMail.
It is NOT shipped inside the app bundle.

## Listing copy

See `store-listing-en.md` for app name, subtitle, descriptions, and keywords.

## Screenshots

```bash
cd apps/mobile/weldmail-app
npx --yes playwright install chromium
node store/screenshots/capture.mjs
```

Outputs land in `store/screenshots/` (iOS 6.7 / 6.5, Android phone, iPad 13", feature graphic). Details in `screenshots/README.md`.
