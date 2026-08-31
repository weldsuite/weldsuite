# WeldAgent, App Store / Play Store + push setup

## Done in-repo

- [x] EAS project id `cc1b21b9-17f3-490b-8088-3c62761d1d00`
- [x] `updates.url` synced to `https://u.expo.dev/cc1b21b9-17f3-490b-8088-3c62761d1d00`
- [x] `EXPO_PUBLIC_EAS_PROJECT_ID` in `app.json` / `eas.json` / OTA deploy job
- [x] Android notification channel `weldagent` (client + orchestrator)
- [x] `expo-notifications` plugin with brand colour + `defaultChannel: weldagent`
- [x] iOS `UIBackgroundModes: remote-notification`
- [x] Privacy manifest via `ios.privacyManifests` in `app.json` (prebuild emits PrivacyInfo.xcprivacy)
- [x] `app.config.js` auto-attaches Firebase files when you drop them in

## You still need to do (credentials — interactive)

Push will not arrive on a physical device until these are done for **this** EAS project
(`weldagent-app` / `com.weldsuite.weldagent`). Do **not** reuse WeldBooks / WeldMail
Firebase app configs — wrong package / bundle id.

### 1. Firebase (shared project `weldsuite`)

In [Firebase Console](https://console.firebase.google.com/) → project **weldsuite**:

1. **Add Android app**
   - Package name: `com.weldsuite.weldagent`
   - Download `google-services.json`
   - Place it at `apps/mobile/weldagent-app/google-services.json`
2. **Add iOS app**
   - Bundle id: `com.weldsuite.weldagent`
   - Download `GoogleService-Info.plist`
   - Place it at `apps/mobile/weldagent-app/GoogleService-Info.plist`
3. Enable **Cloud Messaging** and create / reuse an FCM V1 service-account key
   (Project settings → Service accounts → Generate new private key).

`app.config.js` picks those files up automatically on the next prebuild / EAS build.

### 2. EAS credentials (push)

From the app folder, logged into Expo org `weldsuite`:

```bash
cd apps/mobile/weldagent-app
eas login
eas credentials
```

Then:

| Platform | What to set |
|---|---|
| Android | Google Service Account / **FCM V1** — upload the Firebase service-account JSON |
| iOS | **Push Notifications** key (APNs) — create or reuse a key in Apple Developer, assign to App ID `com.weldsuite.weldagent` |

Also confirm the Apple App ID `com.weldsuite.weldagent` has the **Push Notifications** capability.

### 3. Local `.env`

```bash
cp .env.example .env
```

`.env.example` already has the EAS project id + Clerk test keys.

### 4. First device build (required for push)

Expo Go cannot register push tokens on SDK 53+. Use a dev client or preview build:

```bash
eas build --profile preview --platform ios
eas build --profile preview --platform android
```

On device: sign in → More → enable notifications → background the app, send a chat
turn or run an agent → expect an Expo push that opens `/chat/<id>` or `/agent/<id>`.

## Build / submit

```bash
eas build --profile production --platform all
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

Listing copy: `store-listing-en.md`, privacy: `privacy-policy.md`, Play Data Safety: `data-safety.md`.

## Pre-submission checklist

- [ ] `npx expo-doctor` passes
- [ ] Golden path: login → Home → New chat → send a message → see reply
- [ ] Agent create / activate / run now works
- [ ] Background the app during a chat turn; Expo push arrives; tap opens `/chat/<id>`
- [ ] Agent run complete/fail push opens `/agent/<id>`
- [ ] Credits empty state (402) shows top-up copy, no in-app purchase
- [ ] Deep link `weldagent://` and push `actionUrl` `/weldagent/chat/<id>` resolve
- [ ] Screenshots captured (see `screenshots/`)
- [ ] Privacy policy URL `https://weldsuite.org/privacy`
- [ ] Listing copy copied from `store-listing-en.md`
