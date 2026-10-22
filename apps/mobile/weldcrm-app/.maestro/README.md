# WeldCRM e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator. Setup
(Maestro, emulator, release build, the Windows build workarounds) is the same
as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldcrm`.

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

The workspace needs at least one company: a CRM task has to point at a company or a person
(as on the web), and `02-create-task` links its task to the first company in the picker. It
creates the task ("E2E CRM task <timestamp>"), renames it and deletes it again. `03-create-person` does the same for a person and a company
("E2E Person <timestamp>", "E2E Company <timestamp>"). Both clean up after themselves unless a
step fails halfway.

## Run

```bash
pnpm test:e2e                                 # all flows
maestro test .maestro --exclude-tags writes   # read-only flows
```
