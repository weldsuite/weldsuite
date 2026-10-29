# Screenshots

Capture from a `preview` build (or the Simulator / emulator with a clean status bar)
signed in as the demo account from `../review-notes.md`, in light mode.
Make a second set in Dutch for the `nl` localisation if you want localised shots.

## Sizes

| Folder | Size | Where |
| --- | --- | --- |
| `ios-6.9/` | 1320×2868 | App Store, 6.9" iPhone (required) |
| `ios-6.5/` | 1242×2688 | App Store, 6.5" iPhone (only if the slot is shown) |
| `ios-ipad-13/` | 2064×2752 | App Store, 13" iPad, required because `supportsTablet: true` |
| `android-phone/` | 1080×2340 (or any 9:16–9:19.5) | Play, phone (2–8) |
| `android-feature-graphic/` | 1024×500 | Play, feature graphic (required) |

The Play icon (512×512) is `../../assets/images/icon.png` scaled down.

## Shot list (same order everywhere)

1. Home: next shift with the clock button, my schedule and absences
2. Schedule: my week with shifts and an open shift
3. Absence: my requests and sick reports
4. New leave request with the allowance check
5. Expenses: a claim with a receipt
6. Absence as a manager: who is off, requests waiting for approval
7. Payslips
8. Profile: leave balances and the Face ID lock

Simulator: `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100`.
Android emulator: enable demo mode (`adb shell settings put global sysui_demo_allowed 1`).
