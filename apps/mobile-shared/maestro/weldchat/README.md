# WeldChat e2e flows (Maestro)

Black-box flows for the native WeldChat apps (`apps/ios/Apps/WeldChat`,
`apps/android/apps/weldchat`), ported from the Expo app's `.maestro` flows
(`apps/mobile/weldchat-app/.maestro`). They select on accessibility
identifiers, which are the Android test tags too, so one flow runs on both:
Home and the tabs, posting and deleting a channel message, and the record
chats screen.

```
config.yaml          # runs everything in flows/
flows/               # one journey per file, numbered
subflows/login.yaml  # WeldID's sign-in page, from a fresh install
```

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldChat. No data is needed up
  front: `02-channel-message` creates the public channel `#e2e-maestro` on
  its first run and keeps it, then posts a stamped message and deletes it.
- `APP_ID`: `com.weldsuite.weldchat.dev` (the Android debug build, the
  default) or `com.weldsuite.weldchat` (iOS, an Android release build).
- The flows assert English text: run them on a device set to English.

```bash
maestro test apps/mobile-shared/maestro/weldchat --exclude-tags writes   # read-only
maestro test apps/mobile-shared/maestro/weldchat                         # + a message posted and deleted
```
