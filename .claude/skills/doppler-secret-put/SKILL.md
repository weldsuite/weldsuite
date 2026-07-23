---
name: doppler-secret-put
description: "Push a single secret value from Doppler into a Cloudflare Worker via `wrangler secret put`. Use when the user wants to set/copy ONE secret onto a worker (e.g. GITHUB_APP_ID onto app-api, GITHUB_WEBHOOK_SECRET onto integration-webhook-worker) from Doppler, rather than the full manifest-driven bulk sync. Triggers: 'add a secret', 'put a secret', 'set secret on worker', 'copy secret from doppler', 'wrangler secret put from doppler'."
trigger: /secret-put
---

# /secret-put, Doppler → `wrangler secret put`

Reads one secret from Doppler and sets it on a single Cloudflare Worker. For the
full manifest-driven push of every secret a worker needs, use `secrets:sync`
instead (see `scripts/secrets/manifest.ts`).

## When to use
- A worker is missing one secret (e.g. a 500 "X is not configured").
- You added a worker to the secrets manifest and just want to seed one key now.
- You rotated a single secret in Doppler and need it on one worker.

## Prerequisites
- `DOPPLER_TOKEN`, a Doppler personal/service token with read access to the
  `weldsuite` project. Create at: Doppler Dashboard → Project → Access → Tokens.
- `wrangler` authenticated for the target account (logged in, or
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` set).
- The secret's value must already exist in Doppler for the chosen env/config.

## Usage
```bash
DOPPLER_TOKEN=dp.xxx npx tsx scripts/secrets/put.ts <env> <worker-dir> <SECRET_NAME> [DOPPLER_KEY]
# or
DOPPLER_TOKEN=dp.xxx pnpm secrets:put <env> <worker-dir> <SECRET_NAME> [DOPPLER_KEY]
```
- `<env>`, `test` | `preview` | `production` (also the Doppler **config** name)
- `<worker-dir>`, directory under `apps/` (e.g. `app-api`, `integration-webhook-worker`)
- `<SECRET_NAME>`, the secret name on the worker (and the Doppler key, unless the 4th arg is given)
- `[DOPPLER_KEY]`, optional: read a differently-named Doppler key

The script fetches the value from Doppler (`/v3/configs/config/secret`) and pipes
it to `wrangler secret put <SECRET_NAME> --env <env>` in `apps/<worker-dir>`, so
multi-line values (PEM keys) are handled correctly.

## How to run it (for the agent)
1. Confirm with the user the **env**, **worker**, and **secret name(s)**.
2. Make sure `DOPPLER_TOKEN` is available. If not, ask the user to export it or
   run the command themselves with the `!` prefix (the token must not be hard-coded).
3. Run one `secrets:put` invocation per secret. Never echo the secret value.
4. Remind the user to **deploy** the worker if the binding/secret must take effect.

## Examples
```bash
# GitHub App secrets onto app-api (install flow + callback + Projects API)
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production app-api GITHUB_APP_SLUG
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production app-api GITHUB_APP_ID
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production app-api GITHUB_APP_PRIVATE_KEY

# GitHub App secrets onto integration-webhook-worker (webhook + sync workflows)
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production integration-webhook-worker GITHUB_APP_ID
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production integration-webhook-worker GITHUB_APP_PRIVATE_KEY
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production integration-webhook-worker GITHUB_WEBHOOK_SECRET

# Read a differently-named Doppler key onto a worker secret
DOPPLER_TOKEN=dp.xxx pnpm secrets:put production api-worker BETTERSTACK_TOKEN BETTERSTACK_TOKEN_API_WORKER
```

## Notes
- This is the single-secret companion to `scripts/secrets/sync.ts` (bulk) and
  `scripts/secrets/dev-vars.ts` (local `.dev.vars` generation).
- The Doppler **config** name is taken directly from `<env>`, if your prod
  config is named `prd` (not `production`), pass that and the worker `--env` will
  still be `production`… in that case set `DOPPLER_PROJECT`/config accordingly or
  fall back to `wrangler secret put` by hand.
- Secrets are write-only on Cloudflare; this never reads a value back from a worker.
