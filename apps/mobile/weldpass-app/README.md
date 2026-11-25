# WeldPass mobile (`weldpass-app`)

The WeldPass password manager on iOS and Android: personal and shared vaults,
logins, secure notes and cards, 2FA codes, the password generator and password
health. Expo 57, Expo Router. Plan: `weldsuite-documentation/plans/weldpass-eu.md`,
phase 4; ADRs PASS-001, PASS-007, PASS-010.

## What sets it apart from the other apps

- **WeldSuite EU and self-hosted servers only** (ADR OPS-025, MOB-007):
  `lib/server.ts` lists `servers: ['eu', 'self-hosted']` and needs the `pass`
  module. Sign-in is WeldID's page (`HostedLoginScreen`); there is no Clerk
  (Metro resolves `@clerk/*` to an empty module, ESLint forbids it).
- **No Expo US-hosted services**: no push (WeldPass sends none), no EAS
  Update (no `expo-updates`, no `updates.url`: every release is a store
  build), no Observe, no Mixpanel, no realtime (lists refresh on focus and
  after each write).
- **Always locked** while signed in: `AppLockProvider` from
  `@weldsuite/mobile-ui` in `required` mode, with a 60 s grace period, and
  `confirm()` before every reveal and copy (one confirmation covers the next
  10 s). A phone without a screen lock can't use the app.
- **Secrets stay out of caches and screenshots**: revealed fields live in the
  item screen's state only and are dropped when the app goes to the
  background; item screens block screenshots; the app switcher shows a
  blurred (iOS) or blank (Android, `FLAG_SECURE`) app.
- **Offline copy** (ADR PASS-010, `contexts/OfflineContext.tsx`,
  `lib/offline/`): the phone registers itself and syncs an encrypted copy
  of the vaults the person can read (`/api/weldpass/devices`, Rust servers
  only). The key is 256 random bits in the Keychain / Android Keystore behind
  biometrics, this device only (expo-secure-store); the copy is AES-256-GCM
  (expo-crypto) in the app's own storage, kept out of backups. Unlocking the
  app reads the key, so one Face ID opens both. Sync on unlock, on foreground
  and after every write; lists, search and item fields read from the copy, so
  the app works offline, read-only. Wiped on sign-out (the phone is revoked
  first), on a server switch, when the server says the phone was revoked or
  copies are off, and per vault when access goes. A shared vault's 2FA
  secrets stay on the server (PASS-007), so the edit form always reveals from
  the server. Phones without enrolled biometrics run online only.
- **Sensitive clipboard** (`lib/clipboard.ts`, `modules/weldpass-native`): a
  copied secret is marked sensitive (Android `IS_SENSITIVE`; iOS local-only,
  so no Universal Clipboard) and cleared after 30 s.
- **Native autofill** (phase 4C), reading the offline copy with no network
  and no tokens:
  - iOS: an AutoFill credential provider extension in `targets/autofill`
    (Swift), added at prebuild by `@bacons/apple-targets`. It shares the App
    Group `group.com.weldsuite.weldpass` (the copy's folder) and the Keychain
    group `$(AppIdentifierPrefix)com.weldsuite.weldpass.shared` (the copy's
    key) with the app. After each sync the app fills the system's credential
    identity store with hosts and usernames, never a password.
  - Android: an `AutofillService` in `modules/weldpass-native/android`
    (Kotlin). After each unlock the app hands it the key, wrapped with a
    Keystore key of its own that works only within 30 s of the person
    authenticating; the service's unlock activity opens the copy, matches
    apps by package name (`fields.apps`) and pages by domain. A save request
    opens "New login" with what was typed (`?fromAutofill=1`).
  - Fills are queued in `fills.json` next to the copy and uploaded as
    `autofilled` device events at the next sync. `index.json` there names
    each copy's workspace and device (ids only).

## Layout

```
app/                      Expo Router screens
  (tabs)/                 Items, Vaults, Generator, Settings
  vault/[vaultId].tsx     one vault's items
  item/new.tsx            a new login, note or card
  item/[vaultId]/[itemId] the item (index) and its edit form
  health.tsx              password health
components/               Screen, ItemList, ItemForm, FieldRow, TotpCode, …
contexts/OfflineContext.tsx the offline copy in the running app
hooks/use-passwords.ts    the copy when open, else TanStack Query over /api/weldpass
lib/                      server, i18n (en, nl), clipboard, privacy, errors
lib/offline/              the copy: format and merge, envelope, sync engine, events
modules/weldpass-native/  local Expo module (Swift + Kotlin): clipboard, backups, autofill service
targets/autofill/         the iOS AutoFill credential provider extension (Swift)
store/                    store listing, privacy answers, review notes
.maestro/                 e2e flows
```

The item rules (who may write where, search, the item form) are shared with
the platform: `@weldsuite/app-api-client/schemas/weldpass-items`.

## Commands

```bash
pnpm --filter weldpass-app start      # expo start --dev-client
pnpm --filter weldpass-app test       # Jest
pnpm --filter weldpass-app lint
pnpm --filter weldpass-app type-check
pnpm --filter weldpass-app test:e2e   # Maestro, see .maestro/README.md
```

It needs a development build (the local native module and
`expo-local-authentication` aren't in Expo Go). Native builds go through the
**Mobile native build** workflow (tick WeldPass); see `store/README.md` for the
one-time setup (`eas init`, App Store Connect, Play Console).
