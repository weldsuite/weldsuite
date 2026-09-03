# WeldChat App Assets

Generated from the platform's WeldChat mark
(`apps/web/platform/public/assets/images/weldchat/icon.svg`) so the mobile icon
stays in lockstep with the sidebar / app-store mark. Regenerate with
`scripts/generate-assets.mjs` if that SVG changes.

| File | Spec | Purpose |
|---|---|---|
| `icon.png` | 1024x1024, opaque, no alpha, no rounded corners | iOS/Android app icon (stores mask it) |
| `icon-512.png` | 512x512, opaque, no alpha | Play Console high-res icon |
| `adaptive-icon.png` | 1024x1024 foreground on transparent, mark within the 66% safe zone | Android adaptive icon foreground |
| `splash-icon.png` | 1024x1024 transparent, rendered at `imageWidth: 200` | Splash screen |
| `notification-icon.png` | 96x96 monochrome white on transparent | Android notification tray icon |
| `logo.png` | 512x512 transparent | Login screen logo |

Brand color (Android adaptive background + notification tint): `#00bb67`.
