# Deploy secrets

Set these on GitHub Environments **`test`** and **`production`**
(`Settings → Environments`). Do not put them on the repo itself except
`EXPO_TOKEN` (used by both environments).

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
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | Workers + Pages |
| `CLOUDFLARE_ACCOUNT_ID` | `cfcf560df8dc675d15337abcfbf6d9bd` | Workers + Pages |
| `EXPO_TOKEN` | not in Doppler | WeldMail / WeldChat / WeldBooks OTA (repo-level is fine) |

Worker runtime secrets (set via `wrangler secret put`, not GitHub):

| Secret | Workers |
|---|---|
| `DATABASE_URL_MASTER` | `personal-api`, `mail-inbound-worker`, `app-api`, … |
| `DATABASE_URL_PERSONAL` | `personal-api`, `mail-inbound-worker` |
| `CLERK_SECRET_KEY` / `CLERK_JWT_KEY` | `personal-api`, `app-api`, … |

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
  doppler secrets get DATABASE_URL_PERSONAL --project weldsuite --config "$cfg" --plain \
    | gh secret set PERSONAL_DATABASE_URL --env "$env" -R weldsuite/weldsuite
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
