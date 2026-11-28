# Secrets

The GitHub secrets and environments this repository's workflows use. The
repository is public and holds no deploy secrets: only the `handoff`
environment (the deploy bot) and the release environments below.

Deploys run in the private repo **`weldsuite/weldsuite-deploy`** (ADR
OPS-018): its EU workflows pin the EU clusters, and Flux rolls them out. EU
production follows the test cluster (`eu-production-watch.yml` here, ADR
OPS-020). The cluster secrets are SOPS files in that repo, not GitHub secrets.

Global's deploy is gone. It ran this repo's `deploy-*` actions (Workers, Pages,
Vercel apps, the Expo OTA updates, hosted WeldApps and Global's migrations) on
the private repo's `test` and `production` environments, and was removed on
2026-11-28, after Global's workspaces moved into EU production (ADR OPS-025).
The Workers themselves were deleted from this repo with the rest of Global's
TypeScript backend.

## Deploy bot environment (public)

`eu-production-watch.yml` signs in as the **weldsuite-deploy-bot** GitHub App
(Actions read and write, installed on `weldsuite-deploy` only) to hand a build
to production there. The environment is still called `handoff`, after the test
hand-off it was made for; it allows branch `main` and holds:

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_BOT_CLIENT_ID` | variable | The App's client id (Doppler `WELDSUITE_DEPLOY_BOT_CLIENT_ID`) |
| `DEPLOY_BOT_PRIVATE_KEY` | secret | The App's private key, the `.pem` (Doppler `WELDSUITE_DEPLOY_BOT_PRIVATE_KEY`) |

The repository variable `DEPLOYS_PRIVATE` must be `true`, or nothing is
handed on.

## Release environments (public)

The release workflows, run by hand, each read their own environment:

| Environment | Branch | Workflow | Secrets |
|---|---|---|---|
| `desktop-release` | `main` | `release-desktop.yml` | `CLOUDFLARE_ACCOUNT_ID`, `R2_DOWNLOADS_API_TOKEN`, and optionally `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (signing degrades to unsigned without them) |
| `mobile-release` | `main` | `mobile-build.yml`, channel `production`; `mobile-native-release.yml` | `EXPO_TOKEN`; for the native apps `APP_STORE_CONNECT_API_KEY`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `APPLE_TEAM_ID` (iOS) and `ANDROID_UPLOAD_KEYSTORE`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (Android) |
| `mobile-preview` | `main` | `mobile-build.yml`, channel `preview` | `EXPO_TOKEN` |

Store submission of the Expo apps (`auto-submit` in `mobile-build.yml`) needs
**no GitHub secrets** beyond `EXPO_TOKEN`: the App Store Connect API key and
the Google service account key are stored on EAS, per app, with
`eas credentials`. The workflow header lists the one-time setup.

The native apps (`mobile-native-release.yml`) sign and upload without EAS,
with their own secrets in `mobile-release` (the table above). The workflow
header says what each one is and the one-time setup per app.

## Repo-level (npm publish)

**Happy path:** `publish-cli.yml` uses **npm Trusted Publishing** (GitHub Actions
OIDC). Configure once per package on npmjs.com → Package settings → Trusted
Publisher → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `weldsuite` |
| Repository | `weldsuite` |
| Workflow filename | `publish-cli.yml` (exact; no path) |
| Environment | *(leave empty)* |

Applies to `@weldsuite/cli` and `@weldsuite/app-sdk`. Full click path:
`packages/sdk/cli/PUBLISHING.md`. No GitHub secret required for OIDC publishes.
Provenance is generated automatically for this public repo.

| GitHub secret | Used by |
|---|---|
| `NPM_TOKEN` | **Legacy fallback only.** Optional Automation token for `publish-cli.yml` when the workflow input `use_legacy_npm_token` is true. Do **not** create this for normal releases. Delete the secret (and revoke the npm token) after Trusted Publishing works. Not an Environment secret. |
