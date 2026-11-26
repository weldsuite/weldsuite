# WeldSuite for Android

The native Android apps, in Kotlin and Jetpack Compose. They replace the Expo
apps in `apps/mobile`, one app at a time; WeldPass is the first.

| Module | What |
|---|---|
| `:api` | Retrofit interfaces and kotlinx.serialization models, generated at build time from `apps/mobile-shared/openapi` |
| `:core` | The server and its `/config.json`, WeldID sign-in (AppAuth), the workspace, the API client, secure storage, the app lock |
| `:ui` | The Material 3 theme, the design tokens and `SessionGate`: the screens between launch and an app (sign-in, workspace, lock, server problems) |
| `:apps:weldpass` | WeldPass (`com.weldsuite.weldpass`) |

## Build and run

JDK 17 and the Android SDK (platform 36). From this folder:

```bash
./gradlew :apps:weldpass:installDebug   # on a running emulator or phone
./gradlew testDebugUnitTest lintDebug   # what CI runs, plus assembleDebug
```

Debug builds are `com.weldsuite.weldpass.dev` and start on the EU test
cluster (`app.test.weldsuite.eu`); release builds start on
`app.weldsuite.eu`. Sign-in goes through WeldID's `weldsuite-mobile` client
with the redirect `weldpass://sso-callback`.

Strings, tokens and the API contract come from `apps/mobile-shared`; run
`pnpm mobile:generate` from the repo root after changing them.

## Release

Store builds come from the **Mobile native release** workflow
(`.github/workflows/mobile-native-release.yml`), run by hand on `main`. It
signs the `.aab` with the upload key from the `mobile-release` environment
and uploads it to the Play internal testing track; promoting it is done in
Play Console. A release build signs only when `WELD_UPLOAD_KEYSTORE` and its
passwords are set, and takes its version code from `-PweldVersionCode`.
