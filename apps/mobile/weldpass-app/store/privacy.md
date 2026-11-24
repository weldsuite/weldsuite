# WeldPass, App Store privacy label

Answers for App Store Connect → App Privacy. WeldPass ships no analytics,
no crash reporting service, no advertising and no push. Everything it sends
goes to the WeldSuite server the person signed in to (WeldSuite EU or their
organisation's own server).

## Data collected

| Category | Type | Linked to the user | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact info | Name, email address | Yes | No | App functionality (the account, shown in Settings) |
| User content | Other user content (the logins, notes and cards a person saves) | Yes | No | App functionality |
| Identifiers | User ID | Yes | No | App functionality (the account and workspace) |
| Usage data | Product interaction (each time a password is shown, recorded in the vault's activity) | Yes | No | App functionality (the audit trail a workspace admin sees) |

Not collected: location, contacts, health, financial info beyond what a person
saves in a card item, browsing history, search history (search runs on the
phone), diagnostics, purchases.

## Tracking

No. WeldPass does not track people across other companies' apps or websites.

## Data summary (for the privacy policy)

- Items are encrypted at rest on the server with keys that never leave it.
  They are decrypted only when a signed-in person with access asks, and every
  such request is recorded in the vault's activity.
- On the phone, revealed fields stay in memory while the item is open and are
  dropped when the app goes to the background.
- Copied passwords are marked sensitive and removed from the clipboard after
  30 seconds.
- Sign-in tokens are kept in the iOS Keychain or Android Keystore
  (expo-secure-store).
- An encrypted copy of the vaults the person can open is kept on the phone,
  for offline use (ADR PASS-010): AES-256-GCM, with a key that stays in the
  phone's Keychain / Keystore behind biometrics and never leaves the device.
  It is excluded from backups and wiped on sign-out, when the phone is
  removed in Settings or on the web, and when the workspace turns offline
  copies off. Shared vaults' two-factor secrets are not in it.
- Each sync and each offline reveal or copy is recorded in the vault's
  activity.
