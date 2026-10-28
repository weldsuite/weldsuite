# WeldHR, App Store / Play Store Submission Checklist

Everything needed to get WeldHR listed on the iOS App Store and Google Play.
This directory is NOT shipped inside the app bundle.

| File | What |
| --- | --- |
| `store-listing-en.md`, `store-listing-nl.md` | Name, subtitle, descriptions, keywords, URLs |
| `privacy.md` | App Store privacy label (nutrition label) answers + data summary |
| `data-safety.md` | Google Play Data Safety form answers |
| `review-notes.md` | Notes and demo account for App Review / Play review |
| `screenshots/README.md` | Sizes and shot list |

Identifiers: bundle id and package `com.weldsuite.weldhr`, scheme `weldhr://`, Expo owner `weldsuite`.

## 1. One-time setup (in this order)

### 1.1 EAS project
```bash
cd apps/mobile/weldhr-app
eas login
eas init            # writes extra.eas.projectId into app.json
```
Commit the project id. Until then `app.config.js` refuses CI/EAS builds, and the
`Release WeldHR (mobile)` job in `deploy.yml` skips with a warning.

Then create the EAS environments' variables the same way as the other apps
(the build profiles in `eas.json` already pin the Clerk keys and API URLs).

### 1.2 Firebase (Android push)
`expo-notifications` ships an FCM service. Without a matching `google-services.json`,
`app.config.js` strips that service so the app opens, but Android gets no push.

1. Firebase Console → project **weldsuite** → Add Android app, package `com.weldsuite.weldhr`
2. Download `google-services.json` → `apps/mobile/weldhr-app/google-services.json` (commit it, like WeldFlow)
3. Do **not** reuse another app's file: the `package_name` must match
4. `eas credentials` → WeldHR → Android → FCM V1 service account key
5. `eas credentials` → WeldHR → iOS → Push Notifications key (APNs)

### 1.3 Clerk
Clerk Dashboard (production instance) → **Native applications**:
- iOS: bundle `com.weldsuite.weldhr` + Apple Team ID
- Android: package `com.weldsuite.weldhr` + SHA-256 of the **Play app signing** certificate
  (Play Console → App integrity, available after the first upload) and of the EAS upload key
- Allowed redirect: `weldhr://sso-callback`

Without this, Google / Apple sign-in fails in release builds while email still works.
The in-app "Delete account" (Profile, and the no-workspace screen) goes through
app-api `POST /api/account/delete`, which deletes the Clerk user server-side, so
no Clerk dashboard setting is needed for it.

### 1.4 Apple
1. developer.apple.com → Identifiers → App ID `com.weldsuite.weldhr` with **Push Notifications** and **Sign in with Apple**
2. App Store Connect → New App: name **WeldHR**, primary language English (U.S.), bundle `com.weldsuite.weldhr`, SKU `weldhr`
3. Copy the app's **Apple ID** (App Information) into `eas.json` → `submit.production.ios.ascAppId`
4. App Store Connect API key on EAS: `eas credentials --platform ios` (the same key as the other apps works)

### 1.5 Google Play
1. Play Console → Create app: **WeldHR**, app, free
2. Upload the **first** AAB by hand to Internal testing (the Play API refuses an app's first upload)
3. Google service account key on EAS: `eas credentials --platform android` (the same account as the other apps, granted access to WeldHR)
4. Fill App content: privacy policy, ads (none), app access (demo account, see `review-notes.md`),
   content rating questionnaire, target audience (18+), data safety (`data-safety.md`),
   government app (no), financial features (none)

## 2. Build and submit

Through GitHub Actions → **Mobile native build** → tick **WeldHR**:

- `channel: preview` → internal APK / ad hoc IPA for testing on devices
- `channel: production` + `auto-submit` → TestFlight and the Play **internal** track

Or locally:
```bash
cd apps/mobile/weldhr-app
eas build --profile production --platform all
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

Promoting from TestFlight / internal testing to the public store stays manual.
After the first binary, JS-only changes ship as OTA updates on every push
(`deploy.yml` → `Release WeldHR (mobile)`). Native changes need a version bump
in `app.json` and a new binary.

## 3. Pre-submission checklist

- [ ] `npx expo-doctor` passes in `apps/mobile/weldhr-app`
- [ ] Preview build runs on a physical iPhone and Android phone
- [ ] Golden path: sign in → Home → clock in → request leave → new expense with a receipt photo → manager approves on another account → push arrives on the requester's phone
- [ ] Fresh install, no workspace: the no-workspace screen shows, and Delete account works there
- [ ] Profile → Delete account removes the account and signs out
- [ ] Location prompt only appears when the workspace requires a work location for clock-in
- [ ] Android: merged manifest has no `READ_MEDIA_*` / storage / background-location permission (`blockedPermissions` in `app.json`) and picking a receipt from photos still works
- [ ] Demo workspace seeded and the review account works (see `review-notes.md`)
- [ ] Screenshots captured (`screenshots/README.md`)
- [ ] App privacy (App Store) and Data safety (Play) filled from `privacy.md` / `data-safety.md`
- [ ] Privacy policy URL https://weldsuite.org/privacy live and mentions HR data (absence, payslips, location at clock-in)
- [ ] Support URL https://weldsuite.org/support filled in both consoles
