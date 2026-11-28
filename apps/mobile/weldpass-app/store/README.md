# WeldPass, App Store / Play Store submission checklist

Everything needed to get WeldPass listed on the iOS App Store and Google Play.
This directory is NOT shipped inside the app bundle.

| File | What |
| --- | --- |
| `store-listing-en.md`, `store-listing-nl.md` | Name, subtitle, descriptions, keywords, URLs |
| `privacy.md` | App Store privacy label answers and the data summary |
| `data-safety.md` | Google Play Data safety form answers |
| `review-notes.md` | Notes and the demo account for App Review and Play review |
| `screenshots/README.md` | Sizes and shot list |

Identifiers: bundle id and package `com.weldsuite.weldpass`, scheme
`weldpass://`, Expo owner `weldsuite`.

WeldPass is the first WeldSuite app without Expo's US-hosted services: no
push (WeldPass sends none), no EAS Update (every release is a store build),
no Observe, no Mixpanel. EAS is used for builds and credentials only. It runs
on WeldSuite EU (`https://app.weldsuite.eu`) and self-hosted servers, and
signs in through the server's WeldID; there is no Clerk and no Firebase.

## 1. One-time setup (in this order)

### 1.1 EAS project

Done: the project is `@weldsuite/weldpass-app`, and its id is in `app.json`
(`extra.eas.projectId`). It was made with:

```bash
cd apps/mobile/weldpass-app
eas login
eas init            # writes extra.eas.projectId into app.json
```

Commit only the project id: `eas init` also writes the autofill extension's
`extra.eas.build.experimental` block, which `@bacons/apple-targets` adds at
build time anyway. Without a project id `app.config.js` refuses CI and EAS
builds. There is no `updates.url`: WeldPass ships no OTA updates.

### 1.2 WeldID

`weldpass://sso-callback` is a redirect URI of the `weldsuite-mobile` client
(`rust/deploy/flux/infrastructure/weldid/values/weldid.yaml`). Check that the
EU test and EU production clusters run that config before testing sign-in.
Self-hosted installs add it themselves (`rust/deploy/hetzner/README.md`).

### 1.3 Apple

1. developer.apple.com → Identifiers → App ID `com.weldsuite.weldpass`. No
   push and no Sign in with Apple (sign-in is WeldID's web page). Native
   autofill (phase 4C) needs, on this App ID **and** on a second one,
   `com.weldsuite.weldpass.autofill` (the extension, `targets/autofill`):
   - the **AutoFill Credential Provider** capability;
   - **App Groups** with `group.com.weldsuite.weldpass` (register the group
     under Identifiers → App Groups first).
   The Keychain group (`$(AppIdentifierPrefix)com.weldsuite.weldpass.shared`)
   needs no portal setting. `eas credentials --platform ios` then makes the
   extension's provisioning profile; set `ios.appleTeamId` in `app.json` (the
   team id) so `@bacons/apple-targets` can sign the extension.
2. App Store Connect → New App: name **WeldPass**, primary language English
   (U.S.), bundle `com.weldsuite.weldpass`, SKU `weldpass`.
3. Copy the app's **Apple ID** (App Information) into `eas.json` →
   `submit.production.ios.ascAppId`.
4. App Store Connect API key on EAS: `eas credentials --platform ios` (the
   same key as the other apps works).
5. Export compliance: `ITSAppUsesNonExemptEncryption` is false. WeldPass uses
   only the encryption built into iOS (HTTPS, the Keychain); the offline copy
   is encrypted with the system's AES-GCM (expo-crypto over CryptoKit /
   javax.crypto) to protect the person's own data, which is exempt.

### 1.4 Google Play

1. Play Console → Create app: **WeldPass**, app, free.
2. Upload the **first** AAB by hand to Internal testing (the Play API refuses
   an app's first upload).
3. Google service account key on EAS: `eas credentials --platform android`
   (the same account as the other apps, granted access to WeldPass).
4. App content: privacy policy, ads (none), app access (demo account, see
   `review-notes.md`), content rating, target audience (18+), data safety
   (`data-safety.md`), financial features (none).
5. Autofill (phase 4C): the app declares an `AutofillService`. Play asks for a
   declaration of its use in App content (password manager: core function);
   answer that it fills the person's own saved logins, on the device, from
   the encrypted offline copy.

## 2. Build and submit

Through GitHub Actions → **Mobile native build** → tick **WeldPass**:

- `channel: preview` → internal APK / ad hoc IPA, on the EU test cluster
- `channel: production` + `auto-submit` → TestFlight and the Play
  **internal** track, starting on `https://app.weldsuite.eu`

Or locally:

```bash
cd apps/mobile/weldpass-app
eas build --profile production --platform all
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

Promoting to the public store stays manual. Every change, JS or native, needs
a version bump in `app.json` and a new binary.

## 3. Pre-submission checklist (device checklist)

- [ ] `npx expo-doctor` passes in `apps/mobile/weldpass-app`
- [ ] Fresh install starts on `app.test.weldsuite.eu` (preview) or
      `app.weldsuite.eu` (production); sign-in opens WeldID's page in the
      phone's language and comes back signed in
- [ ] **Lock:** asks Face ID / fingerprint / passcode on launch, after a
      minute in the background, and before showing or copying a password; a
      phone without a screen lock gets the "Set up a screen lock" screen
- [ ] **Clipboard:** a copied password is gone from the clipboard after 30 s;
      Android 13+ shows it masked in the copy preview; on iOS it doesn't
      reach a Mac through Universal Clipboard
- [ ] **Privacy cover:** the app switcher shows a blurred (iOS) or blank
      (Android) WeldPass; screenshots of an item are blocked
- [ ] **Server switch:** Settings → Server → a self-hosted address restarts
      the app on that server (`reloadAppAsync`, no expo-updates)
- [ ] **Viewer:** in a vault where you are a viewer, there is no Add or Edit,
      and a forced write shows "You don't have access…" rather than an error
- [ ] **Missing root key:** against a server without `WELDPASS_ROOT_KEY` the
      vault list shows "WeldPass can't open vaults on this server right now…"
- [ ] Add a login, reveal it, copy its password and its 2FA code
- [ ] **Offline copy:** after a sync, airplane mode: the lists, search and a
      login's password still open; a write says you're offline; back online,
      the reveal shows in the vault's activity on the web
- [ ] **Wipe:** sign out → the copy file and the key are gone; remove the phone
      on the web → its next sync wipes the copy and Settings says so; turn
      offline copies off for the workspace → the same; remove the person from
      a shared vault → that vault leaves the phone
- [ ] **iOS autofill:** Settings → General → AutoFill & Passwords → WeldPass on;
      in Safari, a saved site offers the WeldPass login in the QuickType bar;
      picking it asks for Face ID and fills username and password; the fill
      shows in the vault's activity after the next sync
- [ ] **Android autofill:** Settings → Passwords & autofill → WeldPass (or the
      app's Settings → Autofill → Turn on); in Chrome (Settings → Autofill
      services → "Autofill using another service") and in a native app whose
      package is listed on the login, "Fill with WeldPass" asks for the
      fingerprint and fills; a sign-in in another app offers "Save to
      WeldPass", which opens New login filled in
- [ ] The generator's strength meter matches the web app's
- [ ] Demo workspace seeded and the review account works (`review-notes.md`)
- [ ] Screenshots captured (`screenshots/README.md`)
- [ ] App privacy (App Store) and Data safety (Play) filled from `privacy.md` /
      `data-safety.md`
- [ ] Privacy policy URL live and mentions WeldPass (passwords, the audit
      trail; with 4B the encrypted copy on the phone)
