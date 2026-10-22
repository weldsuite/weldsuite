# WeldBooks e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator. Setup
(Maestro, emulator, release build, the Windows build workarounds) is the same
as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldbooks`.

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

The test workspace needs a **company (entity)**; without one the app stops at
"No company set up yet". Create it on the web (WeldBooks › Create entity):
the in-app "Create company" sheet opens empty on Android (TASK-1164). The
e2e workspace has "E2E Company BV" (NL, EUR).

`03-invoice-draft` creates a draft invoice (and, the first time, the
"E2E Customer" contact) and deletes the draft again. `04-quick-expense` saves
one €25 expense per run.

## Run

```bash
pnpm test:e2e                                 # all flows
maestro test .maestro --exclude-tags writes   # read-only flows
```
