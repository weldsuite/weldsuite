# WeldHR e2e tests (Maestro)

Black-box UI flows that drive the installed app on an Android emulator. Setup
(Maestro, emulator, release build, the Windows build workarounds) is the same
as for WeldMail: see
[`apps/mobile/weldmail-app/.maestro/README.md`](../../weldmail-app/.maestro/README.md).
The package ID here is `com.weldsuite.weldhr`.

```
.maestro/
  config.yaml          # runs everything in flows/
  flows/               # one user journey per file, numbered
  subflows/login.yaml
```

| Flow | Tags | Needs an account |
| --- | --- | --- |
| `00-launch` | smoke, signed-out | no |
| `01-tabs` | smoke | yes |
| `02-forms` | smoke | yes (nothing is saved) |
| `03-language` | smoke | yes |
| `04-leave-roundtrip` | writes | yes (requests leave, then cancels it) |

## Credentials

`subflows/login.yaml` signs in with `MAESTRO_TEST_EMAIL` /
`MAESTRO_TEST_PASSWORD`: a user on the **test** environment, two-step
verification off, linked to an employee record in a workspace with WeldHR. Give
it leave approval rights to see the Team tab in `01-tabs`.

## Run

```bash
pnpm test:e2e                                        # all flows
maestro test .maestro/flows/00-launch.yaml           # no account needed
maestro test .maestro --exclude-tags writes          # read-only flows
```
