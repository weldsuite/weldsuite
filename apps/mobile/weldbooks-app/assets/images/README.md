# WeldBooks app images

Built from the platform's WeldBooks logo
(`apps/web/platform/public/assets/images/weldbooks/icon.svg`, the coins) so the
app icon matches the app rail and the App Store. Rebuild them when that logo
changes:

```bash
pnpm mobile:icons weldbooks-app
```

| File | Spec | Purpose |
|---|---|---|
| `icon.png` | 1024x1024, opaque white, no alpha | iOS/Android app icon (the stores round it) |
| `icon-512.png` | 512x512, opaque white, no alpha | Play Console high-res icon |
| `adaptive-icon.png` | 1024x1024 transparent, the mark inside the 66% safe zone | Android adaptive icon foreground (`backgroundColor` is white) |
| `splash-icon.png` | 1024x1024 transparent, drawn at `imageWidth: 200` | Splash screen |
| `notification-icon.png` | 96x96 white on transparent | Android notification tray icon |
| `logo.png` | 512x512 transparent | Sign-in screen logo |
