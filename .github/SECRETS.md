# Deploy secrets

Set these on GitHub Environments **`test`** and **`production`**
(`Settings → Environments`). Do not put them on the repo itself except
`EXPO_TOKEN` (used by both environments).

Values come from Doppler project `weldsuite` (`test` / `prd` configs).
Doppler's master DB URL is `DATABASE_URL_MASTER`; the workflow reads
`MASTER_DATABASE_URL`.

| GitHub secret | Doppler name | Used by |
|---|---|---|
| `MASTER_DATABASE_URL` | `DATABASE_URL_MASTER` | Neon migrations |
| `DATABASE_ENCRYPTION_KEY` | `DATABASE_ENCRYPTION_KEY` | Tenant migrations |
| `NEON_API_KEY` | `NEON_API_KEY` | Tenant migrations |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | Workers + Pages |
| `CLOUDFLARE_ACCOUNT_ID` | `cfcf560df8dc675d15337abcfbf6d9bd` | Workers + Pages |
| `EXPO_TOKEN` | not in Doppler | WeldMail / WeldChat OTA (repo-level is fine) |

Copy from Doppler without printing values:

```bash
for env in test production; do
  cfg=$([ "$env" = production ] && echo prd || echo test)
  for s in DATABASE_ENCRYPTION_KEY NEON_API_KEY CLOUDFLARE_API_TOKEN; do
    doppler secrets get "$s" --project weldsuite --config "$cfg" --plain \
      | gh secret set "$s" --env "$env" -R weldsuite/weldsuite
  done
  doppler secrets get DATABASE_URL_MASTER --project weldsuite --config "$cfg" --plain \
    | gh secret set MASTER_DATABASE_URL --env "$env" -R weldsuite/weldsuite
  printf 'cfcf560df8dc675d15337abcfbf6d9bd' \
    | gh secret set CLOUDFLARE_ACCOUNT_ID --env "$env" -R weldsuite/weldsuite
done
```

`production` should only deploy from `main` (environment deployment branch
policy). `test` deploys from `develop`.

Optional production-only (desktop release): `R2_DOWNLOADS_API_TOKEN`,
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`.

## Admin app (Vercel)

The internal admin console (`apps/web/admin`) deploys on **Vercel**, not via
`deploy.yml`. One project, two environments — same branch model as the rest of
the stack:

| Branch | Vercel target | URL |
|---|---|---|
| `develop` | Preview (stable) | `admin-test.weldsuite.org` |
| `main` | Production | `admin.weldsuite.org` |

Repo config lives in `apps/web/admin/vercel.json`. Connect the Vercel project
to `weldsuite/weldsuite` with **Root Directory** = `apps/web/admin` and enable
**Include source files outside of the Root Directory in the Build Step**.

### Vercel dashboard checklist

1. Project **`weldsuite-admin`** → Settings → Git → connect `weldsuite/weldsuite`.
2. Root Directory: **`apps/web/admin`**.
3. Production Branch: **`main`**.
4. Domains: assign **`admin-test.weldsuite.org`** to the `develop` branch
   (branch alias); **`admin.weldsuite.org`** to Production.
5. Set env vars below on **Preview** (test / `develop`) and **Production**
   (`main`). Copy values from Doppler `test` / `prd` configs.

### Vercel environment variables

| Variable | Preview (test) | Production |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | admin Clerk test key | admin Clerk live key |
| `CLERK_SECRET_KEY` | admin Clerk test secret | admin Clerk live secret |
| `DATABASE_URL_MASTER` | Doppler `test` → `DATABASE_URL_MASTER` | Doppler `prd` |
| `NEON_API_KEY` | Doppler `test` | Doppler `prd` |
| `DATABASE_ENCRYPTION_KEY` | Doppler `test` | Doppler `prd` |
| `DATABASE_ENCRYPTION_KEY_V2` | if set in Doppler `test` | if set in Doppler `prd` |
| `REALTIME_WORKER_URL` | `https://realtime-test.weldsuite.org` | `https://realtime.weldsuite.org` |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://realtime-test.weldsuite.org` | `wss://realtime.weldsuite.org` |
| `REALTIME_INTERNAL_SECRET` | Doppler `test` | Doppler `prd` |
| `REALTIME_REGISTER_API_KEY` | Doppler `test` (if used) | Doppler `prd` |
| `REALTIME_REGISTER_CUSTOMER` | Doppler `test` (if used) | Doppler `prd` |
| `REALTIME_REGISTER_OTE` | `false` | `false` |
| `RESEND_API_KEY` | optional | optional |

Sync from Doppler (replace `preview` / `production` with Vercel env names):

```bash
PROJECT=weldsuite-admin
for cfg in test:preview prd:production; do
  doppler_cfg="${cfg%%:*}"
  vercel_env="${cfg##*:}"
  for s in DATABASE_URL_MASTER DATABASE_ENCRYPTION_KEY NEON_API_KEY REALTIME_INTERNAL_SECRET; do
    doppler secrets get "$s" --project weldsuite --config "$doppler_cfg" --plain \
      | vercel env add "$s" "$vercel_env" "$PROJECT" --force
  done
done
```

Requires the [Vercel CLI](https://vercel.com/docs/cli) linked to the WeldSuite
team. Clerk keys are set manually in the Vercel UI (admin Clerk instance, not
platform Clerk).

Or run the helper script (Windows PowerShell, from repo root):

```powershell
powershell -NoProfile -File scripts/secrets/sync-admin-vercel.ps1
```

That script sets develop-scoped Preview vars from Doppler `test`, ensures
`admin-test.weldsuite.org` is wired to the `develop` branch, and redeploys the
latest develop preview. Admin Clerk keys are **not** synced from Doppler `test`
(platform Clerk) — they stay on the shared Preview/Production admin Clerk vars.
Add `REALTIME_INTERNAL_SECRET` to Vercel manually if support inbox publish fails
(it is not in Doppler today).
