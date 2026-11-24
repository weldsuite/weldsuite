# WeldPass in the Chrome Web Store and Edge Add-ons

What the store listings say, kept next to the code so a permission change and
its justification change together. Chrome first, then Edge with the same zip
(plan `weldpass-eu.md`, phase 3).

| File | What it is |
| --- | --- |
| [`listing.en.md`](listing.en.md), [`listing.nl.md`](listing.nl.md) | Store listing text: name, summary, description |
| [`permissions.md`](permissions.md) | The single purpose and a reason for every permission, for the Privacy practices tab |
| [`privacy.md`](privacy.md) | The data usage declarations and certifications |

## Still to settle before the first upload

- **Publisher account** under the WeldSuite company (Chrome Web Store
  developer account, then Microsoft Partner Center for Edge).
- **Store item ids.** Create each store item first (upload the zip as a
  draft), so its id exists. Each id's redirect,
  `https://<id>.chromiumapp.org/`, goes on WeldID's `weldsuite-extension`
  client (`rust/deploy/flux/infrastructure/weldid/values/weldid.yaml`), and
  on step 7 "2d" of `rust/deploy/hetzner/README.md` for Zitadel installs.
  Until then a store build can't sign in.
- **Privacy policy URL** on `weldsuite.eu`.
- **Screenshots**: at least one, 1280×800 (up to five), and the 440×280
  small promo tile.

## Releasing a version

1. Bump `version` in `apps/web/weldpass-extension/package.json` and merge it
   to `main`.
2. Push the tag `weldpass-extension-v<version>`. The workflow
   **Release WeldPass extension** (`.github/workflows/release-weldpass-extension.yml`)
   type-checks, runs the unit tests and the Playwright run, builds the store
   zip and attaches it to the run, with its SHA-256 in the summary. It
   uploads nothing.
3. Download the zip from the run and upload it in the Chrome Web Store
   developer dashboard (**Package → Upload new package**), then in Partner
   Center for Edge. Check the listing and privacy tabs against the files
   here before submitting.

To build the same zip locally:

```bash
pnpm --filter weldpass-extension zip   # → apps/web/weldpass-extension/release/weldpass-extension-<version>.zip
```

The zip script refuses a build with a `key` (the store rejects one), with a
default server other than WeldSuite EU, or with source maps.

## Review

The content script on every `https://` page is a broad host permission, which
means Chrome's in-depth review and a longer first approval. Keep the
justifications in [`permissions.md`](permissions.md) exact: reviewers compare
them with the manifest and the code.
