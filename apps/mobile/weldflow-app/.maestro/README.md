# WeldFlow e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator (or iOS
simulator on a Mac). Setup, the release build and the Windows build
workarounds are the same as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldflow`.

```
.maestro/
  config.yaml          # runs everything in flows/
  flows/               # one user journey per file, numbered
  subflows/login.yaml
```

## Test data

The test user (`MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`) needs a
workspace with WeldFlow and **at least one project it belongs to**. The app
can't create projects; make one on the web. `03-task-lifecycle` creates one
task per run (title `E2E task <timestamp>`), assigns it to the test user and
leaves it Done, so it never piles up in the Open lists.

## Run

```bash
pnpm test:e2e                                         # all flows
maestro test .maestro/flows/03-task-lifecycle.yaml    # one flow
maestro test .maestro --exclude-tags writes           # read-only flows
```
