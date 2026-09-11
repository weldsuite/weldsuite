# WeldFlow, App Store / Play Store Submission Checklist

This directory holds everything you need to get WeldFlow listed on the iOS App Store and Google Play.
It is NOT shipped inside the app bundle.

## Before first build

### 1. Expo / EAS setup
EAS project is already linked (`extra.eas.projectId` in `app.json`). Confirm you are logged in:
```bash
cd apps/mobile/weldflow-app
eas login
eas project:info
```

### 2. Firebase client file (required for Android not to crash / for push)

`expo-notifications` ships an FCM service. Without a matching `google-services.json`,
Play installs can die on first open (`Default FirebaseApp is not initialized`).

1. Firebase Console → project **weldsuite** → Add Android app
2. Package name: `com.weldsuite.weldflow` (exact)
3. Download `google-services.json` → place at `apps/mobile/weldflow-app/google-services.json`
4. Do **not** reuse WeldMail / WeldBooks files — wrong `package_name`
5. Upload the FCM V1 service account to this EAS project:
```bash
eas credentials
```
Select WeldFlow → Android → Google Service Account / FCM V1 (and iOS → Push Key).

Until the file exists, `app.config.js` strips `ExpoFirebaseMessagingService` so the app
can still launch; push stays off until you add the file and rebuild.

### 2b. Clerk Native application
Clerk Dashboard → **Native applications** → enable Native API and register:
- Android package: `com.weldsuite.weldflow`
- iOS bundle: `com.weldsuite.weldflow`

### 3. Secrets / build env
Clerk + API URLs are pinned per profile in `eas.json` (same pattern as WeldBooks).
OTA deploys from `.github/workflows/deploy.yml` inject the same Clerk keys.

Optional Mixpanel:
```bash
eas secret:create --scope project --name EXPO_PUBLIC_MIXPANEL_TOKEN --value xxx --type string --environment production
```

### 4. Assets
Replace the placeholder images in `assets/images/` (copied from welddesk-app) with WeldFlow-branded versions. See `assets/images/README.md` for specs.

### 5. Apple Developer account
- App ID: `com.weldsuite.weldflow` (create in App Store Connect)
- Push notifications capability enabled on the App ID
- Create an app record in App Store Connect with name "WeldFlow"

### 6. Google Play Console
- Package name: `com.weldsuite.weldflow`
- Create an app listing (internal testing track to start)
- Fill out the Data Safety questionnaire (see `data-safety.md`)

## Build flow

```bash
# iOS preview (TestFlight internal)
eas build --profile preview --platform ios

# Android preview (internal testing)
eas build --profile preview --platform android

# Production (App Store / Play Store)
eas build --profile production --platform all
```

## Submit flow

```bash
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

## Pre-submission checklist

- [ ] `expo-doctor` passes: `npx expo-doctor`
- [ ] App runs on physical iPhone via `eas build --profile preview --platform ios`
- [ ] App runs on physical Android via `eas build --profile preview --platform android`
- [ ] Golden path works: login → workspace selected → Projects tab → open a project → open a task → change status → see change reflected on the web platform
- [ ] Push notification for task-assigned arrives on both OSes
- [ ] Deep link `weldflow://project/<id>` opens the project detail
- [ ] First-run flow on a freshly installed app does not crash
- [ ] Screenshots generated (`node store/screenshots/capture.mjs`) and reviewed
- [ ] Privacy manifest `ios/PrivacyInfo.xcprivacy` is present and reviewed
- [ ] Data Safety form completed in Play Console (see `data-safety.md`)
- [ ] Privacy policy URL live at https://weldsuite.org/privacy and filled in both consoles
- [ ] Terms of Service URL filled in both consoles
- [ ] Support URL (`https://weldsuite.com/support`) filled in both consoles
- [ ] App name, subtitle, description, keywords copied from `store-listing-en.md`
- [ ] Build number / version number correct (`autoIncrement: true` handles this for prod)

## Screenshots

UI-faithful mockups (same pipeline as WeldBooks / WeldChat):

```bash
cd apps/mobile/weldflow-app
npx --yes playwright install chromium
node store/screenshots/capture.mjs
```

Outputs: `screenshots/ios-6.7/`, `ios-6.5/`, `android-phone/`, `ios-ipad-13/`, `android-feature-graphic/`. Shot list and upload notes in `screenshots/README.md`.
