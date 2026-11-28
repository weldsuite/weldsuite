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

## Global's Workers (until they are deleted)

Runtime settings of Global's Workers, which nothing deploys any more. They go
with the Workers (ADR OPS-025, phase 8).

Worker runtime **vars** (not GitHub secrets) — set in `wrangler.toml` per env:

| Var | Workers |
|---|---|
| `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS` | `app-api`, `external-api`. Comma-separated workspace ids whose new WeldApps are `publisherType=weldsuite` (Official store badge, skip public review). |

The booking portal (`apps/web/booking-portal`) is a Next.js host, not a Worker.
Give it `DATABASE_URL_PERSONAL` (alias `PERSONAL_DATABASE_URL`) so personal
booking pages at `/p/{slug}` can read the shared personal Neon DB. Workspace
bookings still use `MASTER_DATABASE_URL` + tenant resolution. Do not put the
personal URL on tenant DBs, and do not let `/p/` read a workspace Neon.

Worker runtime secrets (set via `wrangler secret put`, not GitHub):

| Secret | Workers |
|---|---|
| `DATABASE_URL_MASTER` | `personal-api`, `mail-inbound-worker`, `app-api`, … |
| `DATABASE_URL_PERSONAL` | `personal-api`, `mail-inbound-worker`, booking-portal (`/p/{slug}`) |
| `CLERK_SECRET_KEY` / `CLERK_JWT_KEY` | `personal-api`, `app-api`, … |
| `INTERNAL_API_SECRET` | `app-api`, `agent-runtime`, `integration-*`, `helpdesk-workflow-worker`, … |
| `BILLING_ADMIN_SECRET` | `billing-worker`; the admin console (`apps/web/admin`) holds the same value |
| `WORKSPACE_ADMIN_SECRET` | `workspace-worker` (`/api/internal/admin/*`: database moves, live shard state, shard sizes); the admin console holds the same value, next to `WORKSPACE_WORKER_URL` (`https://workspace-worker-test.weldsuite.org` / `https://workspace-worker.weldsuite.org`). 32+ random characters; unset or shorter, the routes answer 503. The console also sends the admin's `x-admin-email`, `x-admin-user-id` and `x-admin-role` headers; only a `superadmin` can start, cancel or recover a move |
| `OUTBOUND_ADMIN_SECRET` | `mail-api` (`/internal/outbound/*`); the admin console holds the same value, next to `MAIL_API_URL` |
