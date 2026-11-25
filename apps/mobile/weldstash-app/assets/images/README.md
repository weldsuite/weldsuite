# WeldStash app images

Built from the platform's WeldStash logo
(`apps/web/platform/public/assets/images/weldstash/icon.svg`, the warehouse
with its shutter) so the app icon matches the app rail and the App Store.
Rebuild them when that logo changes:

```bash
pnpm mobile:icons weldstash-app
```

| File | Spec | Purpose |
| --- | --- | --- |
| `icon.png` | 1024x1024, opaque white, no alpha | iOS / store launcher icon |
| `adaptive-icon.png` | 1024x1024 transparent, the mark inside the 66% safe zone | Android adaptive icon foreground (`backgroundColor` is white) |
| `splash-icon.png` | 1024x1024 transparent | Native splash (light `#ffffff` / dark `#000000`) |
| `notification-icon.png` | 96x96 white on transparent | Android notification (tinted by the plugin's `color`) |
| `logo.png` | 512x512 transparent | Sign-in screen |
