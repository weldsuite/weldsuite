# WeldDesk e2e flows (Maestro)

Black-box flows for the native WeldDesk apps (`apps/ios/Apps/WeldDesk`,
`apps/android/apps/welddesk`). They select on accessibility identifiers,
which are the Android test tags too, so one flow runs on both. The Expo app
had no flows; these cover its main paths: the inbox's filters, sort and
search; a conversation's note, reply, close / reopen and assignment; and
settings with sign-out.

```
config.yaml          # runs everything in flows/
flows/               # one journey per file, numbered
subflows/login.yaml  # WeldID's sign-in page, from a fresh install
```

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldDesk and at least one open
  conversation.
- `APP_ID`: `com.weldsuite.welddesk.dev` (the Android debug build, the
  default) or `com.weldsuite.welddesk` (iOS, an Android release build).
- The flows assert English text: run them on a device set to English.

```bash
maestro test apps/mobile-shared/maestro/welddesk --exclude-tags writes     # read-only
maestro test apps/mobile-shared/maestro/welddesk --exclude-tags customer   # + a note and assignments
maestro test apps/mobile-shared/maestro/welddesk                           # + a reply the customer gets
```
