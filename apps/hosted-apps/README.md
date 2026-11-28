# First-party hosted WeldApps

New WeldSuite-owned apps live here as **separate Vite frontends**. They are not compiled into the platform SPA (`apps/web/platform`). The platform hosts the production bundle in R2 and renders it in a sandboxed iframe at `/apps/{code}`.

Each app is a normal WeldApp:

- Same scaffold as `weld app init` (`weldapp.json`, `@weldsuite/app-sdk`)
- Same scoped App API (`https://api.weldsuite.org/v1`, `wsat_` tokens — no Clerk in the iframe)
- Same install path (`workspace_installed_apps` with `appType: 'user'`)

## Layout

```text
apps/hosted-apps/
  <code>/          # one folder per app; folder name = weldapp.json `code`
    weldapp.json
    package.json
    src/
```

Copy `packages/sdk/cli/templates/app` (or run `weld app init` and move the result here). Prefer workspace deps:

```json
"@weldsuite/app-sdk": "workspace:*"
```

Do not put a package under `_template/` — that name is ignored by CI and `pnpm-workspace.yaml`.

## Official publisher

Apps created from a workspace listed in `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS` (wrangler var on `app-api` and `external-api`) get `publisherType: weldsuite`. They skip public-store review and show an **Official** badge in the App Store.

## Local loop

```bash
cd apps/hosted-apps/<code>
pnpm install
export WELD_API_KEY=wsk_...          # publisher workspace key
export WELD_API_URL=https://api-test.weldsuite.org   # or production
export WELD_DEV_USER_ID=user_...     # required with a workspace key
pnpm exec weld app create            # once
pnpm exec weld app dev               # platform on localhost:3000
# pnpm exec weld app dev --tunnel    # hosted HTTPS platform
pnpm exec weld app deploy
pnpm exec weld app publish           # auto-approves for official publishers
```

## Deploying

Nothing deploys hosted apps automatically. Global's deploy did, for every changed `apps/hosted-apps/<code>/` with a `weldapp.json`, until it was removed on 2026-11-28 (ADR OPS-025); where the EU install keeps hosted app bundles is still open. Until then, deploy by hand with `weld app deploy` (the local loop above).

Bump `version` in `weldapp.json` before deploying a change: duplicate versions are rejected.

Existing first-party **SPA modules** (WeldCRM, WeldDesk, WeldCommerce, …) stay in `apps/web/platform`. Do not migrate them here unless that is an explicit follow-up. (WeldCommerce briefly shipped as a hosted app and is an SPA module again.)

Sibling folder outside this monorepo: `../weldsuite-apps/` can hold independently versioned first-party apps that publish via the CLI / developer portal the same way.
