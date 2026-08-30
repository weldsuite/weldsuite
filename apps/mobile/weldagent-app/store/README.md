# WeldAgent, App Store / Play Store Submission Checklist

This directory holds listing copy for the iOS App Store and Google Play.
It is NOT shipped inside the app bundle.

## Cannot be completed from this repo

These steps need Expo / Apple / Google logins and must not be faked:

1. `eas init` under Expo org `weldsuite` → real `projectId` + `updates.url`
2. Apple App ID `com.weldsuite.weldagent` with Push capability + APNs key
3. Play package `com.weldsuite.weldagent` + FCM V1 via `eas credentials`
4. `google-services.json` / `GoogleService-Info.plist` for **this** package
   (do **not** copy WeldBooks or WeldFlow files — wrong package name)
5. First `eas build` / store submit

Until those exist, `app.config.js` fails loudly on CI/EAS if the project id is still the placeholder.

## Before first build

### 1. Expo / EAS setup
```bash
cd apps/mobile/weldagent-app
eas login
eas init
eas project:info
```

Paste the resulting project id into `app.json` (`expo.extra.eas.projectId` + `expo.updates.url`) and `.env` (`EXPO_PUBLIC_EAS_PROJECT_ID`).

### 2. Push credentials
```bash
eas credentials
```
Select the WeldAgent project → Android → Google Service Account / FCM V1, and iOS → Push Key.

### 3. Secrets / build env
Clerk + API URLs are pinned per profile in `eas.json` (same pattern as WeldBooks).
OTA deploys from `.github/workflows/deploy.yml` inject the same Clerk keys.

### 4. Assets
Regenerate branded PNGs from the platform SVG:
```bash
pnpm --filter weldagent-app generate:assets
```

### 5. Apple Developer account
- App ID: `com.weldsuite.weldagent`
- Push notifications capability enabled
- App record named "WeldAgent"

### 6. Google Play Console
- Package name: `com.weldsuite.weldagent`
- Data Safety questionnaire (see `data-safety.md`)

## Build flow

```bash
eas build --profile preview --platform ios
eas build --profile preview --platform android
eas build --profile production --platform all
```

## Submit flow

```bash
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

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
