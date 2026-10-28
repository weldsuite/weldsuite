# Screenshots

UI-faithful mockups of the WeldHR app (teal `#0D9488`, the black Clock in button,
date tiles with a coloured bar, the floating tab bar), the same pipeline as
WeldFlow / WeldCalendar / WeldBooks. Generated from `scenes.html`:

```bash
npx --yes playwright install chromium
node apps/mobile/weldhr-app/store/screenshots/capture.mjs
```

The scenes are built from the app's own components (`constants/brand.ts`,
`components/Row.tsx`, `components/Grouped.tsx`, `app/(tabs)/index.tsx`); when the
UI changes, update `scenes.html` and recapture. If a store rejects mockups,
recapture the same screens from a `preview` build signed in to the demo account.

## Output

| Folder | Size | Where |
| --- | --- | --- |
| `ios-6.3/` | 1206×2622 | App Store, iPhone with Dynamic Island (6.3"), the slot App Store Connect asks for |
| `ios-6.9/` | 1320×2868 | App Store, 6.9" iPhone |
| `ios-6.5/` | 1242×2688 | App Store, 6.5" iPhone (only if the slot is shown) |
| `ios-ipad-13/` | 2064×2752 | App Store, 13" iPad (`supportsTablet: true`) |
| `android-phone/` | 1080×2341 | Play, phone (2–8) |

The Play feature graphic and 512×512 icon are in `../graphics/`.

## Shot list (same order everywhere)

1. Home: today's shift with Clock in, my schedule, my absences
2. Schedule: the week, an open shift to sign up for
3. Absence: my requests and sick reports
4. Request leave, with the allowance check
5. Expenses: claims with category tiles and totals
6. Absence as a manager: who is off, requests to approve
7. Pay: payslips and the annual statement
8. Profile: leave balances, Face ID / fingerprint lock

The demo data (Northwind Retail, Sanne de Vries) is made up.
