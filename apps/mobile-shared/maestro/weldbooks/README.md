# WeldBooks e2e flows (Maestro)

Black-box flows for the native WeldBooks apps (`apps/ios/Apps/WeldBooks`,
`apps/android/apps/weldbooks`), ported from the Expo app's `.maestro` flows.
They select on accessibility identifiers, which are the Android test tags
too, so one flow runs on both.

```
config.yaml                    # runs everything in flows/
flows/                         # one journey per file, numbered
subflows/login.yaml            # WeldID's sign-in page, from a fresh install
subflows/close-camera.yaml     # the scanner opens on the camera; close it
subflows/pick-first-photo.yaml # the newest photo in the system picker
assets/receipt-albert-heijn.png
```

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldBooks and a Dutch company
  "E2E Company BV" (EUR). `06-create-company` creates it when the workspace
  has none.
- `APP_ID`: `com.weldsuite.weldbooks.dev` (the Android debug build, the
  default) or `com.weldsuite.weldbooks` (iOS, an Android release build).
- The flows assert English text and euro amounts: run them on a device set to
  English.

What the `writes` flows leave behind: `03-invoice-draft` creates a draft
invoice (and the first time the "E2E Customer" contact) and deletes the draft;
`04-quick-expense` books a €30.25 expense per run; `07-scan-receipt` adds the
receipt image to the gallery, scans it (with or without OCR) and books €32.48;
`08-switch-company` adds "E2E Second BV" on its first run, then switches back
and forth; `09-offline-scan` queues an expense with its photo in airplane mode
and checks it synced (its `onFlowComplete` turns airplane mode off again).

The flows reference `../assets/...`, so run the folder, not a single file:

```bash
maestro test apps/mobile-shared/maestro/weldbooks --exclude-tags writes   # read-only
maestro test apps/mobile-shared/maestro/weldbooks                         # everything
```
