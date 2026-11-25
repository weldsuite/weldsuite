# WeldPass screenshots

Take them from a production build on the demo workspace (`../review-notes.md`),
in light mode, English and Dutch. Screenshots of item screens are blocked in
the app, so capture those from the simulator (iOS) or with
`adb exec-out screencap` on a debug build.

## Sizes

| Store | Device | Size (portrait) |
| --- | --- | --- |
| App Store | 6.9" iPhone (16 Pro Max) | 1320 × 2868 |
| App Store | 6.5" iPhone (11 Pro Max) | 1242 × 2688 |
| App Store | 13" iPad (if `supportsTablet` stays on) | 2064 × 2752 |
| Google Play | Phone | 1080 × 1920 or larger, 9:16 |

## Shot list

1. `01-signin.png`: the sign-in screen (WeldPass logo, "Sign in", the EU server row)
2. `02-items.png`: All items, with logins, a note and a card
3. `03-item.png`: a login with its password shown and the 2FA code counting down
4. `04-vaults.png`: Vaults, the personal vault and two shared ones
5. `05-generator.png`: the generator with a strong password
6. `06-health.png`: Password health with weak and reused passwords
7. `07-lock.png`: the lock screen ("WeldPass is locked")

Save them as `en/0N-name.png` and `nl/0N-name.png`.
