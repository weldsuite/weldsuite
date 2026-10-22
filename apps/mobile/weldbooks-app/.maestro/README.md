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
the in-app "Create company" sheet used to open empty on Android (TASK-1164, fixed).
The e2e workspace has "E2E Company BV" (NL, EUR).

`06-create-company` only does something on a workspace without a company: it
signs in, and if it lands on "No company set up yet" it creates "E2E Company BV"
through the sheet. On a workspace that already has one it passes straight through.

`03-invoice-draft` creates a draft invoice (and, the first time, the
"E2E Customer" contact) and deletes the draft again. `04-quick-expense` books
one €30.25 expense per run (approved and paid, under a supplier named
"E2E Supplier <timestamp>").

`07-scan-receipt` adds `assets/receipt-albert-heijn.png` to the device gallery,
picks it in the scanner and books it as a €32.48 quick expense, then checks the
receipt on the form and on the bill. It passes with or without OCR: a workspace
without AI credits says "Not enough AI credits" and the figures are typed in.
The flow references the image as `../assets/...`, so run it through the
`.maestro` folder (`maestro test .maestro`), not as a single file.

`09-offline-scan` turns airplane mode on, scans the same receipt, queues a
€12.10 expense with the photo, turns airplane mode off and checks the synced
bill shows the receipt. Its `onFlowComplete` hook turns airplane mode off again,
also when a step fails.

`08-switch-company` needs "E2E Company BV". Its first run adds "E2E Second BV"
(More › Administration › Add company); later runs switch to it, check its lists
are its own, and switch back.

### Camera on the emulator

Give the AVD a virtual-scene back camera (`hw.camera.back=virtualscene`) to see a
live preview. Photos taken with expo-camera on the emulator come out black
(the stock Camera app's photos don't), so the flows pick a gallery photo
instead of pressing the shutter; check the shutter on a real phone.

## Run

```bash
pnpm test:e2e                                 # all flows
maestro test .maestro --exclude-tags writes   # read-only flows
```
