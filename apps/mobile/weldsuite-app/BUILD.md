# WeldSuite App - Development Build Guide

This guide will help you create a development build for the WeldSuite mobile app. Since the app uses `react-native-auth0`, which requires native modules, you cannot use Expo Go and must create a development build.

## Prerequisites

### Required Tools
- **Node.js 20+** (already installed)
- **pnpm 10.4.1+** (already installed)
- **Expo CLI**: Install globally with `npm install -g @expo/cli eas-cli`

### For Android Development
- **Android Studio** with Android SDK
- **Java Development Kit (JDK) 17**
- **Android device or emulator**

### For iOS Development (Mac only)
- **Xcode 15+** with Command Line Tools
- **CocoaPods**: Install with `sudo gem install cocoapods`
- **iOS device or simulator**

## Step 1: Set Up Auth0 Configuration

### 1.1 Create Your Auth0 Application

1. Go to [Auth0 Dashboard](https://manage.auth0.com/)
2. Navigate to **Applications > Applications**
3. Click **Create Application**
4. Choose **Native** as application type
5. Copy your **Domain** and **Client ID**

### 1.2 Configure Auth0 Application Settings

In your Auth0 application settings, add the following callback URLs:

**Allowed Callback URLs:**
```
weldsuiteapp://auth.weldsuite.org/android/com.weldsuite.weldsuiteapp/callback,
weldsuiteapp://auth.weldsuite.org/ios/com.weldsuite.weldsuiteapp/callback
```

**Allowed Logout URLs:**
```
weldsuiteapp://auth.weldsuite.org/android/com.weldsuite.weldsuiteapp/callback,
weldsuiteapp://auth.weldsuite.org/ios/com.weldsuite.weldsuiteapp/callback
```

**Allowed Web Origins:**
```
weldsuiteapp://*
```

### 1.3 Create .env File

Create a `.env` file in the `apps/mobile/weldsuite-app` directory:

```bash
cd apps/mobile/weldsuite-app
cp .env.example .env
```

Edit `.env` and add your Auth0 credentials:

```env
EXPO_PUBLIC_AUTH0_DOMAIN=auth.weldsuite.org
EXPO_PUBLIC_AUTH0_CLIENT_ID=your-client-id-here
```

## Step 2: Install Dependencies

From the monorepo root:

```bash
cd E:\Repos\weldsuite
pnpm install
```

## Step 3: Choose Your Build Method

You have two options for creating a development build:

### Option A: Local Development Build (Recommended for Testing)

This method builds the app directly on your machine.

#### For Android:

```bash
cd apps/mobile/weldsuite-app
npx expo prebuild --clean
npx expo run:android
```

**What this does:**
- Generates native Android project files
- Installs all native dependencies including `react-native-auth0`
- Builds and installs the app on your connected Android device or emulator
- Starts the Metro bundler

**Requirements:**
- Android device connected via USB with USB debugging enabled, OR
- Android emulator running in Android Studio

#### For iOS (Mac only):

```bash
cd apps/mobile/weldsuite-app
npx expo prebuild --clean
npx expo run:ios
```

**Requirements:**
- iOS simulator running, OR
- iOS device connected with proper provisioning profile

### Option B: EAS Build (Recommended for Team Distribution)

This method builds your app in the cloud using Expo Application Services.

#### 3.1 Install EAS CLI

```bash
npm install -g eas-cli
```

#### 3.2 Log in to Expo

```bash
eas login
```

If you don't have an Expo account, create one at [expo.dev](https://expo.dev).

#### 3.3 Configure EAS Project

```bash
cd apps/mobile/weldsuite-app
eas init
```

This will link your project to an Expo account.

#### 3.4 Build for Android

```bash
eas build --profile development --platform android
```

**What this does:**
- Builds a development APK in the cloud
- Includes all native modules
- Provides a download link when complete

**Installation:**
1. Download the APK from the link provided
2. Transfer to your Android device
3. Install the APK (you may need to allow installation from unknown sources)

#### 3.5 Build for iOS

```bash
eas build --profile development --platform ios
```

**What this does:**
- Builds a development build for iOS
- Requires Apple Developer account for device installation

**Installation:**
1. Register your device UDID with Apple Developer
2. Download and install the build via the provided link

## Step 4: Start the Development Server

After installing your development build, start the Metro bundler:

```bash
cd apps/mobile/weldsuite-app
npx expo start --dev-client
```

**Options:**
- Press `a` to open on Android
- Press `i` to open on iOS
- Scan QR code with your development build app

## Step 5: Verify Installation

1. Open the WeldSuite app on your device
2. You should see the login screen
3. Tap **Log In** to test Auth0 authentication
4. You should be redirected to Auth0's login page

## Troubleshooting

### Error: "A0Auth0 could not be found"

**Cause:** You're using Expo Go instead of a development build.

**Solution:** Create a development build using one of the methods above.

### Error: "No matching version found for expo-dev-client"

**Cause:** Incorrect version specified.

**Solution:** Already fixed - we're using `expo-dev-client@~6.0.16`

### Build Fails on Android

**Common issues:**
1. **Java version:** Ensure JDK 17 is installed and set in `JAVA_HOME`
2. **Android SDK:** Install Android SDK Platform 34 in Android Studio
3. **Gradle cache:** Clear with `cd android && ./gradlew clean`

### Build Fails on iOS

**Common issues:**
1. **CocoaPods:** Run `cd ios && pod install --repo-update`
2. **Xcode version:** Ensure Xcode 15+ is installed
3. **Provisioning:** Check your Apple Developer account settings

### Metro Bundler Issues

Clear cache and restart:
```bash
npx expo start --dev-client --clear
```

## Development Workflow

### Making Changes

1. **Code changes:** Reload the app with `Cmd+R` (iOS) or `R` (Android)
2. **Native changes:** Rebuild with `npx expo run:android` or `npx expo run:ios`
3. **Config changes:** Run `npx expo prebuild --clean` and rebuild

### Testing Auth0

1. The app will redirect to Auth0's hosted login page
2. Enter credentials or use social login
3. After authentication, you'll be redirected back to the app
4. Check the alert showing your access token

## Next Steps

### Production Build

When ready for production:

```bash
# Update version in app.json
eas build --profile production --platform all
```

### App Store Submission

Follow the EAS Submit guide:
```bash
eas submit --platform ios
eas submit --platform android
```

## Additional Resources

- [Expo Development Builds Docs](https://docs.expo.dev/develop/development-builds/introduction/)
- [React Native Auth0 Docs](https://github.com/auth0/react-native-auth0)
- [EAS Build Docs](https://docs.expo.dev/build/introduction/)
- [Auth0 React Native Quickstart](https://auth0.com/docs/quickstart/native/react-native)

## Quick Reference Commands

```bash
# Local Android build
npx expo run:android

# Local iOS build
npx expo run:ios

# EAS cloud build (Android)
eas build --profile development --platform android

# EAS cloud build (iOS)
eas build --profile development --platform ios

# Start dev server
npx expo start --dev-client

# Clear cache
npx expo start --dev-client --clear

# Prebuild (regenerate native folders)
npx expo prebuild --clean
```

## Support

If you encounter issues not covered here:
1. Check Expo forums: https://forums.expo.dev/
2. Check Auth0 community: https://community.auth0.com/
3. Check GitHub issues for react-native-auth0
