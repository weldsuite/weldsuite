# WeldFlow, App Store / Play Store Submission Checklist

This directory holds everything you need to get WeldFlow listed on the iOS App Store and Google Play.
It is NOT shipped inside the app bundle.

## Before first build

### 1. Expo / EAS setup
```bash
cd apps/mobile/weldflow-app
eas init          # creates the EAS project, writes projectId into app.json
eas login         # if not already signed in
```
Replace the `"extra.eas.projectId": "TODO_RUN_EAS_INIT"` placeholder with the real ID, and commit.

### 2. Secrets, EAS
Set the Clerk publishable key per environment:
```bash
eas secret:create --scope project --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_live_xxx --type string --environment production
eas secret:create --scope project --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_test_xxx --type string --environment preview
```
(`EXPO_PUBLIC_APP_API_URL` is already pinned per profile in `eas.json`.)

### 3. Assets
Replace the placeholder images in `assets/images/` (copied from welddesk-app) with WeldFlow-branded versions. See `assets/images/README.md` for specs.

### 4. Apple Developer account
- App ID: `com.weldsuite.weldflow` (create in App Store Connect)
- Push notifications capability enabled on the App ID
- Create an app record in App Store Connect with name "WeldFlow"

### 5. Google Play Console
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
