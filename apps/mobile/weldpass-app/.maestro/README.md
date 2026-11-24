# WeldPass e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator. Setup
(Maestro, emulator, release build, the Windows build workarounds) is the same
as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldpass`.

```
.maestro/
  config.yaml          # runs everything in flows/
  flows/               # one user journey per file, numbered
  subflows/login.yaml  # WeldID's sign-in page
  subflows/unlock.yaml # the system's lock prompt
```

## Credentials and the emulator

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the **EU
  test cluster** (`app.test.weldsuite.eu`, where development and preview
  builds start), with a password, two-step verification off, and a member of
  a workspace with WeldPass. WeldPass signs in on WeldID's own page in a
  Chrome tab, so the subflow fills WeldID's form, not the app's.
- `MAESTRO_DEVICE_PIN`: the emulator's screen-lock PIN. WeldPass is always
  locked and won't run on a phone without a screen lock, so set a PIN
  (Settings → Security → Screen lock) and leave fingerprints unenrolled: the
  lock prompt is then Android's PIN screen, which the unlock subflow fills.

Export them, or keep them in a gitignored `.env.e2e` and load it first.

## Test data

None needed up front. `02-add-reveal-copy` adds a login with a stamped title
to the personal vault, reveals and copies its password, and deletes it again.

The flows assert English text, so run them on an emulator set to English.

## Run

```bash
pnpm test:e2e                                 # all flows
maestro test .maestro --exclude-tags writes   # read-only flows
```
