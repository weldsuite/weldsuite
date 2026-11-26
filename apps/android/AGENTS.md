# Native Android apps (`apps/android`)

Kotlin and Jetpack Compose. Read the root `AGENTS.md` first, and
`apps/ios/AGENTS.md`: the two platforms are built in step.

- **One feature, both platforms, one PR.** A change to a screen or to the
  core lands in `apps/android` and `apps/ios` together, unless it only exists
  on one platform (an autofill service, a widget).
- **API types are generated, never written by hand.** Change
  `apps/mobile-shared/openapi/<module>.yaml`, and the Rust handler it
  describes, together. Enums are written inline in the spec: the Kotlin
  generator marks a property that references an enum schema `@Contextual`,
  which doesn't decode.
- **Strings live in `apps/mobile-shared/strings`**, never in a module's
  `res/values` by hand. `en` and `nl` both. Run `pnpm mobile:generate`.
- **The core has no UI; `:ui` has no app logic.** An app module only holds
  its own screens and the calls to its own API.
- **Every request goes through `ApiClient`**, which adds the token,
  `X-Weld-App` and `X-Weld-Workspace`. Never build a Retrofit instance in an
  app module.
- **Secrets stay out of state that outlives a screen**: revealed fields live
  in the screen's state and are dropped on `ON_STOP`; nothing secret goes in
  a repository or on disk unencrypted.
- **Tests**: JUnit for the core and each app's logic (`src/test`). Maestro
  flows select on Compose test tags (`Modifier.tagged(...)`), which become
  resource ids through `testTagsAsResourceId` in `SessionGate`.
- Before you finish: `./gradlew testDebugUnitTest lintDebug assembleDebug`.
