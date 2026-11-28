# WeldSuite for Android

The native Android apps, in Kotlin and Jetpack Compose. They replace the Expo
apps in `apps/mobile`: WeldPass, WeldBooks, WeldMail, WeldCalendar, WeldChat,
WeldDesk and WeldHR so far.

| Module | What |
|---|---|
| `:api` | Retrofit interfaces and kotlinx.serialization models, generated at build time from `apps/mobile-shared/openapi`: `:api` itself from `core.yaml`, `:api:<app>` from `<app>.yaml` |
| `:core` | The server and its `/config.json`, WeldID sign-in (AppAuth), the workspace, the API client, secure storage, the app lock, the realtime socket, push token registration, date and money formatting |
| `:ui` | The Material 3 theme, the design tokens, `SessionGate` (the screens between launch and an app: sign-in, workspace, lock, server problems), the shared components and the settings every app has |
| `:push` | Push for the apps that use it (all but WeldPass): Firebase Cloud Messaging, set up in code from build settings, the messaging service, notification channels and taps |
| `:apps:<app>` | One per app, `com.weldsuite.<app>`: `weldpass`, `weldbooks`, `weldmail`, `weldcalendar`, `weldchat`, `welddesk`, `weldhr` |

## Build and run

JDK 17 and the Android SDK (platform 36). From this folder:

```bash
./gradlew :apps:weldpass:installDebug   # on a running emulator or phone
./gradlew testDebugUnitTest lintDebug   # what CI runs, plus assembleDebug
```

Debug builds are `com.weldsuite.<app>.dev` and start on the EU test cluster
(`app.test.weldsuite.eu`); release builds start on `app.weldsuite.eu`.
Sign-in goes through WeldID's `weldsuite-mobile` client with the redirect
`<app>://sso-callback`.

Push needs the Firebase project the apps share: `WELD_FCM_PROJECT_ID`,
`WELD_FCM_API_KEY`, `WELD_FCM_SENDER_ID` and the app's own
`WELD_FCM_APP_ID_<APP>`, as Gradle properties or in the environment. Without
them an app builds and runs without push.

Strings, tokens and the API contract come from `apps/mobile-shared`; run
`pnpm mobile:generate` from the repo root after changing them.

## Release

Store builds come from the **Mobile native release** workflow
(`.github/workflows/mobile-native-release.yml`), run by hand on `main`. It
signs the `.aab` with the upload key from the `mobile-release` environment
and uploads it to the Play internal testing track; promoting it is done in
Play Console. A release build signs only when `WELD_UPLOAD_KEYSTORE` and its
passwords are set, and takes its version code from `-PweldVersionCode`.
