# WeldHR e2e flows (Maestro)

Black-box flows for the native WeldHR apps (`apps/ios/Apps/WeldHR`,
`apps/android/apps/weldhr`), ported from the Expo app's `.maestro` flows.
They select on accessibility identifiers, which are the Android test tags
too, so one flow runs on both.

```
config.yaml          # runs everything in flows/
flows/               # one journey per file, numbered
subflows/login.yaml  # WeldID's sign-in page, from a fresh install
```

| Flow | Tags | Needs an account |
| --- | --- | --- |
| `00-launch` | smoke, signed-out | no |
| `01-tabs` | smoke | yes |
| `02-forms` | smoke | yes (nothing is saved) |
| `03-settings` | smoke | yes (signs out at the end) |
| `04-leave-roundtrip` | writes | yes (requests leave, then cancels it) |

The Expo app's `03-language` switched the language in the app's own
settings; the native apps follow the phone's per-app language, so
`03-settings` checks the shared settings and signs out instead.

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldHR, linked to an employee
  record, with leave requests and expense claims switched on. Give it leave
  approval rights to see Absence → Requests.
- `APP_ID`: `com.weldsuite.weldhr.dev` (the Android debug build, the
  default) or `com.weldsuite.weldhr` (iOS, an Android release build).
- The flows assert English text: run them on a device set to English.

```bash
maestro test apps/mobile-shared/maestro/weldhr --exclude-tags writes   # read-only
maestro test apps/mobile-shared/maestro/weldhr                         # + a leave request, cancelled again
```
