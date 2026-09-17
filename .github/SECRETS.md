# Deploy secrets

Set these on GitHub Environments **`test`** and **`production`**
(`Settings → Environments`). Do not put them on the repo itself except
`EXPO_TOKEN` (used by both environments — repo-level is fine).

This repository is **public**. Environment secrets stay encrypted and are
only exposed to jobs that declare `environment:`. Protect them with
deployment branch policies:

| Environment | Allowed branches | Notes |
|---|---|---|
| `test` | `develop` | Auto-deploys on push to develop |
| `production` | `main` | Prefer a required reviewer on production |

Values come from Doppler project `weldsuite` (`test` / `prd` configs).
Doppler's master DB URL is `DATABASE_URL_MASTER`; the workflow reads
`MASTER_DATABASE_URL`. Personal DB URL is `DATABASE_URL_PERSONAL`; the
workflow reads `PERSONAL_DATABASE_URL`.

| GitHub secret | Doppler name | Used by |
|---|---|---|
| `MASTER_DATABASE_URL` | `DATABASE_URL_MASTER` | Master Neon migrations |
| `PERSONAL_DATABASE_URL` | `DATABASE_URL_PERSONAL` | Shared personal Neon migrations |
| `DATABASE_ENCRYPTION_KEY` | `DATABASE_ENCRYPTION_KEY` | Tenant migrations |
| `NEON_API_KEY` | `NEON_API_KEY` | Tenant migrations |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | Workers + Pages + D1 migrations |
| `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` | Workers + Pages + D1 migrations |
| `EXPO_TOKEN` | not in Doppler | WeldMail / WeldChat / WeldBooks OTA (repo-level is fine) |

Optional frontend build secrets (on both environments if used):

| GitHub secret | Used by |
|---|---|
| `VITE_BOOKING_PORTAL_URL` | Platform + WeldCalendar Pages builds |
| `VITE_MEETING_PORTAL_URL` | Platform Pages build |
| `VITE_MIXPANEL_TOKEN` | Platform Pages build |
| `VITE_BETTERSTACK_SOURCE_TOKEN` | Platform Pages build |

Cloudflare Pages projects for the developer portal (create manually; Git auto-deploy off):

| Project | Custom domain |
|---|---|
| `developer-web-test` | `developer-test.weldsuite.org` |
| `developer-web` | `developer.weldsuite.org` |

Also add both hostnames to Clerk **Allowed origins** / **Redirect URLs**.

First-party hosted WeldApps (`apps/hosted-apps/`, workflow `deploy-hosted-apps.yml`):

| GitHub secret | Used by |
|---|---|
| `HOSTED_APPS_WELD_API_KEY` | Publisher workspace `wsk_` key (`user-apps:manage`). Test env targets `https://api-test.weldsuite.org`; production targets `https://api.weldsuite.org`. Leave unset to skip the job. |

### Repo-level (npm publish)

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

Copy from Doppler without printing values:

```bash
for env in test production; do
  cfg=$([ "$env" = production ] && echo prd || echo test)
  for s in DATABASE_ENCRYPTION_KEY NEON_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    doppler secrets get "$s" --project weldsuite --config "$cfg" --plain \
      | gh secret set "$s" --env "$env" -R weldsuite/weldsuite
  done
  doppler secrets get DATABASE_URL_MASTER --project weldsuite --config "$cfg" --plain \
    | gh secret set MASTER_DATABASE_URL --env "$env" -R weldsuite/weldsuite
  doppler secrets get DATABASE_URL_PERSONAL --project weldsuite --config "$cfg" --plain \
    | gh secret set PERSONAL_DATABASE_URL --env "$env" -R weldsuite/weldsuite
done
```

`production` should only deploy from `main` (environment deployment branch
policy). `test` deploys from `develop`.

Optional production-only (desktop release): `R2_DOWNLOADS_API_TOKEN`,
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`.
