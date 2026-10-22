# WeldMail e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator (or
iOS simulator on a Mac). No native test code in the app; flows find elements
by `testID` first and by visible text / accessibility label otherwise.

```
.maestro/
  config.yaml        # runs everything in flows/
  flows/             # one user journey per file, numbered
  subflows/login.yaml
```

## One-time setup

1. **Maestro CLI** (needs Java 17+): download `maestro.zip` from the
   [releases](https://github.com/mobile-dev-inc/Maestro/releases), unzip, put
   `maestro/bin` on PATH. Check with `maestro --version`.
2. **Android SDK** `platform-tools` and `emulator` on PATH, and an emulator
   (a Pixel AVD on **API 35 or 36**). Maestro's on-device driver dies on the
   API 37 preview images (`Device server died during 'viewHierarchy'`). If the
   emulator crashes as soon as a WebView opens (`Unhandled Vulkan structure
   type` in its log), start it with `-gpu swiftshader_indirect`.
3. **Test user**: a Clerk user on the *test* instance with a workspace that has
   WeldMail installed and a connected mailbox with some mail in it. Export its
   credentials; Maestro picks up `MAESTRO_*` variables on its own:

   ```bash
   export MAESTRO_TEST_EMAIL=...
   export MAESTRO_TEST_PASSWORD=...
   ```

## Build and install the app

A release build talks to the test API (`.env`, copied from the `preview`
profile in `eas.json`) and has its JS bundled, so no Metro is needed:

```bash
npx expo prebuild -p android --no-install
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/release/app-release.apk
```

On Windows, a deep checkout path (e.g. a `.claude/worktrees/...` worktree)
pushes CMake's `.cxx` files in `node_modules` past the 260-character limit, and
the build fails with `ninja: error: manifest 'build.ninja' still dirty after
100 tries`. Either turn on Windows long paths (`LongPathsEnabled`, admin), or
stage native builds in a short folder by appending this to the generated
`android/build.gradle` (`subst` / junctions don't help: Node resolves them
back to the long path):

```groovy
subprojects { sub ->
  if (sub.state.executed) return
  sub.plugins.withId('com.android.library') {
    sub.android.externalNativeBuild.cmake.buildStagingDirectory = new File("C:/cxx/${sub.name}")
  }
}
```

## Run

```bash
pnpm test:e2e                                  # all flows
maestro test .maestro/flows/03-compose.yaml    # one flow
maestro studio                                 # inspect the screen, try commands
```

## Writing flows

- Add a `testID` to anything a flow taps or asserts on; text breaks when the
  copy or the language changes. Naming: `<screen>-<element>`, e.g.
  `compose-send`, `inbox-email-row`.
- Every flow starts with `runFlow: ../subflows/login.yaml` (fresh install,
  signed in, inbox visible), so flows don't depend on each other.
- Flows must not send mail or change shared data on the test account unless
  they clean up after themselves.
