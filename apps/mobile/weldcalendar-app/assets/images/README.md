# WeldCalendar app assets

These are **generated from the platform's brand vector**, not hand-made, so the
mobile icon cannot drift from the web mark. To regenerate after a brand change,
run from the repo root (`sharp` is hoisted there):

```bash
node apps/mobile/weldcalendar-app/scripts/generate-icons.cjs
```

Sources:

- `apps/web/platform/public/assets/images/weldcalendar/icon.svg` — the mark
- `apps/web/platform/public/assets/images/weldcalendar/logo-text-light.png` — the wordmark

| File | Spec | Purpose |
|---|---|---|
| `icon.png` | 1024×1024, **opaque**, no alpha, square corners | iOS/Android app icon (the stores apply their own mask) |
| `adaptive-icon.png` | 1024×1024 foreground on transparent | Android adaptive icon; composited over `android.adaptiveIcon.backgroundColor` and masked, so the mark sits inside the ~66% safe zone |
| `splash-icon.png` | 1024×1024 on transparent | Splash; `expo-splash-screen` paints the background |
| `notification-icon.png` | 256×256 on transparent | Android notification tray. Android uses the **alpha channel only** and tints the silhouette with the plugin's `color`, so the source colour is irrelevant |
| `logo.png` | 1536×179 wordmark on transparent | Login screen |

Brand colour (Android notification tint, accents): `#FE466C`.
