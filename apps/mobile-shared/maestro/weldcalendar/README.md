# WeldCalendar e2e flows (Maestro)

Black-box flows for the native WeldCalendar apps (`apps/ios/Apps/WeldCalendar`,
`apps/android/apps/weldcalendar`), ported from the Expo app's
`.maestro/`. They select on accessibility identifiers, which are the Android
test tags too, so one flow runs on both.

```
config.yaml          # runs everything in flows/
flows/               # one journey per file, numbered
subflows/login.yaml  # WeldID's sign-in page, from a fresh install
```

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldCalendar.
- `APP_ID`: `com.weldsuite.weldcalendar.dev` (the Android debug build, the
  default) or `com.weldsuite.weldcalendar` (iOS, an Android release build).
- The flows assert English text: run them on a device set to English.
- No data is needed up front. `02-event` creates a one-hour event on the
  default calendar and deletes it again.

```bash
maestro test apps/mobile-shared/maestro/weldcalendar --exclude-tags writes   # read-only
maestro test apps/mobile-shared/maestro/weldcalendar                         # + an event created and deleted
```
