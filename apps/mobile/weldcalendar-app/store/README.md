# WeldCalendar — App Store / Play Store Submission Checklist

This directory holds everything you need to get WeldCalendar listed on the iOS App Store and Google Play.
It is NOT shipped inside the app bundle.

## Before first build

### 1. Expo / EAS setup
EAS project is already linked (`extra.eas.projectId` in `app.json`). Confirm you are logged in:
```bash
cd apps/mobile/weldcalendar-app
eas login
eas project:info
```

### 2. Firebase client files (required for push)

`google-services.json` and `GoogleService-Info.plist` are already in the app root for
`com.weldsuite.weldcalendar`. Do **not** reuse another app's client files.

Upload the FCM V1 service account (and iOS Push / APNs key) to this EAS project:
```bash
eas credentials
```
Select WeldCalendar → Android → Google Service Account / FCM V1 (and iOS → Push Key).

### 2b. Clerk Native application
Clerk Dashboard → **Native applications** → enable Native API and register:
- Android package: `com.weldsuite.weldcalendar`
- iOS bundle: `com.weldsuite.weldcalendar`

### 3. Secrets / build env
Clerk + API URLs are pinned per profile in `eas.json`.
OTA deploys from `.github/workflows/deploy.yml` inject the same keys + personal-api URL.

### 4. Apple Developer account
- App ID: `com.weldsuite.weldcalendar` (create in App Store Connect)
- Push notifications capability enabled on the App ID
- Create an app record in App Store Connect with name "WeldCalendar"

### 5. Google Play Console
- Package name: `com.weldsuite.weldcalendar`
- Create an app listing (internal testing track to start)
- Fill out the Data Safety questionnaire (see `data-safety.md`)

## Build flow

```bash
# Preview (internal)
eas build --profile preview --platform android
eas build --profile preview --platform ios

# Production (App Store / Play Store)
eas build --profile production --platform all
```

Or via GitHub Actions: **Mobile native build** → tick **WeldCalendar** → channel `preview` or `production`.

## Submit flow

```bash
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

## Pre-submission checklist

- [ ] `npx expo-doctor` passes
- [ ] App runs on physical iPhone via `eas build --profile preview --platform ios`
- [ ] App runs on physical Android via `eas build --profile preview --platform android`
- [ ] Golden path: login → agenda → open event → edit → month view → calendars list
- [ ] Push notification arrives on both OSes (after FCM V1 / APNs on EAS)
- [ ] Deep link `weldcalendar://event/<id>` opens the event
- [ ] First-run flow on a freshly installed app does not crash
- [ ] Screenshots generated (`node store/screenshots/capture.mjs`) and reviewed
- [ ] Data Safety form completed in Play Console (see `data-safety.md`)
- [ ] Privacy policy URL live at https://weldsuite.org/privacy
- [ ] Support URL (`https://weldsuite.org/support`) filled in both consoles
- [ ] App name, subtitle, description, keywords copied from `store-listing-en.md`
- [ ] Build number / version number correct (`autoIncrement: true` handles this for prod)

## Screenshots

```bash
cd apps/mobile/weldcalendar-app
npx --yes playwright install chromium
node store/screenshots/capture.mjs
```

Outputs: `screenshots/ios-6.7/`, `ios-6.5/`, `android-phone/`, `ios-ipad-13/`, `android-feature-graphic/`.
Shot list and upload notes in `screenshots/README.md`.
