# WeldCalendar e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator. Setup
(Maestro, emulator, release build, the Windows build workarounds) is the same
as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldcalendar`.

```
.maestro/
  config.yaml          # runs everything in flows/
  flows/               # one user journey per file, numbered
  subflows/login.yaml
```

## Credentials

`subflows/login.yaml` signs in with `MAESTRO_TEST_EMAIL` /
`MAESTRO_TEST_PASSWORD` (a user on the **test** environment, two-step
verification off). Export them, or keep them in a gitignored `.env.e2e` and
load it before running.

## Test data

No data is needed up front. `02-event` creates a one-hour event on the
default calendar and deletes it again.

## Run

```bash
pnpm test:e2e                                 # all flows
maestro test .maestro --exclude-tags writes   # read-only flows
```
