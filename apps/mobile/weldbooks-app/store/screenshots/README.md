# Screenshots

Marketing captures that match the WeldBooks mobile UI (emerald `#10B981`, floating pill nav, KPI chips, inbox rows). Generated from `scenes.html`.

```bash
npx --yes playwright install chromium
node store/screenshots/capture.mjs
```

These are UI-faithful mockups for listing review. If App Store / Play reject them, recapture the same six screens from a `preview` or `production` build on a real device (or Simulator with a clean status bar).

## Output

- `ios-6.7/` — 1284×2778 (App Store 6.7" iPhone)
- `ios-6.5/` — 1242×2688 (App Store 6.5" iPhone)
- `android-phone/` — 1080×2341 (Play Store phone, 2–8)
- `ios-ipad-13/` — 2064×2752 (required because `supportsTablet: true`)
- `android-feature-graphic/` — 1024×500

## Shot list (same order on every size)

1. Sign in
2. Dashboard
3. Invoices
4. Invoice detail
5. Receipt scan
6. Expenses

Upload in that order. Play Console: phone screenshots from `android-phone/`, feature graphic from `android-feature-graphic/feature-graphic.png`. App Store Connect: 6.7" from `ios-6.7/` (1284×2778), 6.5" from `ios-6.5/` if that slot is shown, 13" iPad from `ios-ipad-13/`.
