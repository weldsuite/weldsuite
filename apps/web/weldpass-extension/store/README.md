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
- **Screenshots**: done. The four 1280×800 screenshots and the 440×280 small
  promo tile are in [`screenshots/`](screenshots). They show the real
  extension against the Playwright fake server, on a made-up company's
  sign-in page. To regenerate them after a UI change, run
  `pnpm --filter weldpass-extension screenshots`
  (`e2e/store-screenshots.ts`).

## Releasing a version

1. Bump `version` in `apps/web/weldpass-extension/package.json` and merge it
   to `main`. Both stores refuse a version that isn't higher than theirs.
2. Push the tag:

   ```bash
   git tag weldpass-extension-v<version> origin/main
   git push origin weldpass-extension-v<version>
   ```

3. The workflow **Release WeldPass extension**
   (`.github/workflows/release-weldpass-extension.yml`) type-checks, runs the
   unit tests and the Playwright run, builds the store zip and attaches it to
   the run, with its SHA-256 in the summary. Then, for each store set up for
   [uploads from CI](#uploads-from-ci), a job uploads the zip and submits it
   for review (`scripts/store-publish.mjs`); the run's summary says where
   each stands. A store that isn't set up gets no job: download the zip from
   the run and upload it in its dashboard (Chrome: **Package → Upload new
   package**; Partner Center: **Update**).
4. Once a version passes review, Chrome and Edge update installed copies on
   their own within hours. The APIs upload only the package: when a release
   changes what the listing or privacy tabs say, update them in the
   dashboards from the files here.

Re-running a release is safe. The Chrome job does nothing when the version is
already submitted or published, and refuses while another version is still in
review: wait for the review or cancel it in the dashboard, then **Re-run
failed jobs**. Edge refuses a submission while another is in review
(`InProgressSubmission`); re-run its job once that one is through.

A version that asks for a new permission with a warning turns the extension
off for every user until they accept it, which is why
`src/manifest/manifest.test.ts` pins the permission set.

To build the same zip locally:

```bash
pnpm --filter weldpass-extension zip   # → apps/web/weldpass-extension/release/weldpass-extension-<version>.zip
```

The zip script refuses a build with a `key` (the store rejects one), with a
default server other than WeldSuite EU, or with source maps.

## Uploads from CI

Neither store's API can create an item, so the first version of each is
uploaded by hand ([above](#still-to-settle-before-the-first-upload)). After
that, a store's job runs on every release tag once its settings below exist.

### Chrome Web Store

The job signs in as a Google service account through Workload Identity
Federation, so no key is stored anywhere, and only this workflow running from
a `weldpass-extension-v*` tag of this repository can get a token.

1. In a Google Cloud project, enable the Chrome Web Store API and the IAM
   Service Account Credentials API, and create a service account. It needs no
   roles.

   ```bash
   gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com --project <project>
   gcloud iam service-accounts create weldpass-extension-release --project <project>
   ```

2. A workload identity pool with a GitHub provider that admits only this
   workflow at a release tag, and the right for the repository to act as the
   service account (if the project already has a `github` pool, add the
   provider to it):

   ```bash
   gcloud iam workload-identity-pools create github --project <project> --location global
   gcloud iam workload-identity-pools providers create-oidc weldpass-extension \
     --project <project> --location global --workload-identity-pool github \
     --issuer-uri https://token.actions.githubusercontent.com \
     --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition "assertion.job_workflow_ref.startsWith('weldsuite/weldsuite/.github/workflows/release-weldpass-extension.yml@refs/tags/weldpass-extension-v')"
   gcloud iam service-accounts add-iam-policy-binding \
     weldpass-extension-release@<project>.iam.gserviceaccount.com --project <project> \
     --role roles/iam.workloadIdentityUser \
     --member "principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/github/attribute.repository/weldsuite/weldsuite"
   ```

3. Chrome Web Store developer dashboard → **Account** → add the service
   account's email. A publisher can have one service account.
4. Repository variables (Settings → Secrets and variables → Actions →
   Variables). Set the item id last: it turns the job on.

   | Variable | Value |
   | --- | --- |
   | `CHROME_WEB_STORE_PUBLISHER_ID` | Dashboard → **Publisher → Settings** |
   | `CHROME_WEB_STORE_SERVICE_ACCOUNT` | `weldpass-extension-release@<project>.iam.gserviceaccount.com` |
   | `CHROME_WEB_STORE_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project number>/locations/global/workloadIdentityPools/github/providers/weldpass-extension` |
   | `CHROME_WEB_STORE_STAGED` | Optional. `true` holds an approved version until someone presses **Publish** in the dashboard; otherwise it goes live once approved. |
   | `CHROME_WEB_STORE_ITEM_ID` | The item's id, on its **Package** tab |

The API publishes with the item's current visibility. After changing the
visibility in the dashboard, publish once there before the API can again.

### Edge Add-ons

1. Partner Center → Microsoft Edge → **Publish API** → enable the new
   experience → **Create API credentials**. Note the client id, the API key
   and the key's expiry date: put a new key in the secret before then.
2. The API key as the secret `EDGE_ADDONS_API_KEY` of the environment
   `weldpass-extension-stores` (Settings → Environments). Limit that
   environment's deployment tags to `weldpass-extension-v*`.
3. Repository variables `EDGE_ADDONS_CLIENT_ID` and, last, because it turns
   the job on, `EDGE_ADDONS_PRODUCT_ID` (the extension's overview page in
   Partner Center, under "Extension identity").

## Review

The content script on every `https://` page is a broad host permission, which
means Chrome's in-depth review and a longer first approval. Keep the
justifications in [`permissions.md`](permissions.md) exact: reviewers compare
them with the manifest and the code.
