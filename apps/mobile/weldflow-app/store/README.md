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

### 2. Push credentials (required for notifications)
Upload FCM V1 (Android) and APNs (iOS) credentials to this EAS project:
```bash
eas credentials
```
Select the WeldFlow project → Android → Google Service Account / FCM V1, and iOS → Push Key.
Without these, Expo push token registration fails on device builds.

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
- [ ] Screenshots captured on required device sizes (see `screenshots/`)
- [ ] Privacy manifest `ios/PrivacyInfo.xcprivacy` is present and reviewed
- [ ] Data Safety form completed in Play Console (see `data-safety.md`)
- [ ] Privacy policy URL live at https://weldsuite.org/privacy and filled in both consoles
- [ ] Terms of Service URL filled in both consoles
- [ ] Support URL (`https://weldsuite.com/support`) filled in both consoles
- [ ] App name, subtitle, description, keywords copied from `store-listing-en.md`
- [ ] Build number / version number correct (`autoIncrement: true` handles this for prod)

## Screenshots needed

iOS (required):
- 6.7" iPhone (1290×2796 or 1320×2868), at least 3, max 10
- 6.5" iPhone (1242×2688 or 1284×2778), optional
- 12.9" iPad Pro (2048×2732), required because `supportsTablet: true`

Android:
- Phone (1080×1920 or higher), 2 to 8 screenshots
- 7" tablet and 10" tablet, optional but recommended
- Feature graphic (1024×500)

Suggested shots:
1. Projects list with a few filled projects
2. Project detail with task list
3. Task detail with status picker open
4. My Tasks grouped view
5. Dark mode variant of one of the above
