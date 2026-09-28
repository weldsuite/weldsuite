---
name: extract-api-module
description: "Move one weld* module's API out of apps/workers/app-api into its own worker (apps/workers/<module>-api), per docs/plans/app-api-module-split.md. Use when asked to extract, split out or move a module (crm, desk, mail, host, …) from app-api, or to continue the app-api module split."
---

# Extract one module from app-api

Plan: `docs/plans/app-api-module-split.md`. WeldPass (`apps/workers/pass-api`) is the
finished reference. Keep **behaviour identical**: paths, responses, permissions and
entity events do not change. Only where the code lives and which worker serves it.

## 0. Know what you are moving

```bash
pnpm api:ownership <module>          # the module's files, outside imports, inbound imports
pnpm api:ownership                   # SHARED files (used by >1 module)
pnpm api:ownership --core-shared     # files core keeps that modules also use
```

The module's prefixes are already in `packages/core/api-modules/src/index.ts`. If the
move shows a prefix is in the wrong module, fix the manifest and say so in your report.

## 1. Scaffold

```bash
pnpm create:module-api <module>      # apps/workers/<module>-api + secrets-manifest entry
pnpm install
```

## 2. Move the module's own files (keep history)

`git mv` every file the ownership report gives the module (routes, services, lib,
middleware, cron, their `*.test.ts`) to the same relative path under
`apps/workers/<module>-api/src/`. Then fix imports with
`node scripts/api-module-rewrite-imports.mjs <module>-api`, which applies this table and
lists every import that still points outside the worker (step 3 material):

| Old import (relative, in app-api) | New import |
|---|---|
| `…/db` | `@weldsuite/worker-kit/db` |
| `…/lib/response`, `lib/id`, `lib/log-safe`, `lib/atomically`, `lib/webhook-token`, `lib/pg-errors`, `lib/dns-lookup` | `@weldsuite/worker-kit/<name>` |
| `…/lib/cloudflare-email` | `@weldsuite/worker-email` |
| `…/middleware/clerk` / `workspace-db` / `feature-flags` / `request-id` | `@weldsuite/worker-kit/middleware/<name>` |
| `…/test/harness` | `@weldsuite/worker-kit/testing` |
| `…/test/pglite` | `@weldsuite/worker-kit/testing/pglite` |
| `…/types` (`Env`, `Variables`) | the worker's own `src/types.ts` |

Add every package the moved code imports to the worker's `package.json` (`workspace:*`
for `@weldsuite/*`, the same version range app-api uses for npm packages).

## 3. Shared code: never import across workers

A file the module needs that **core or another module also uses** cannot stay in
app-api and cannot be imported from another worker. Move it (with `git mv`) to:

1. **`@weldsuite/worker-kit`** when it is generic and dependency-light (no module
   tables, no heavy packages). Add a subpath export.
2. **A vendor package** `packages/core/<vendor>` (`@weldsuite/<vendor>`) when it is a
   third-party API client (Stripe, Sendcloud, Telnyx, Discord, …).
3. **The owning module's domain package** `packages/domains/<owner>`
   (`@weldsuite/<owner>-domain`) when it is module logic others use (the owner is the
   module whose tables/concept it is, even if that module has not moved yet). One
   subpath export per file, e.g. `@weldsuite/crm-domain/companies`. Create the package
   on first use: copy `packages/core/worker-email`'s package.json/tsconfig/vitest layout.

In every case:
- Leave a one-line re-export shim at the old app-api path when app-api still imports it:
  `// Moved to <pkg>; this re-export keeps existing imports working.` +
  `export * from '<pkg>/<subpath>';`
- A function that takes app-api's `env: Env` must take a small structural type naming
  only the keys it reads (see `WorkerEmailEnv` in `@weldsuite/worker-email`).
- Move the file's tests with it.

Side effects that need a binding only the owning worker has (a Durable Object, a
Workflow, a queue it consumes) are not package material: stop and report them.

## 4. The worker

- `src/types.ts`: `Env extends KitEnv` with **only** the bindings/secrets the moved
  code reads (copy their doc comments from app-api's `src/types.ts`).
- `src/index.ts`: mount the routes exactly as app-api did (same paths, same order;
  public/webhook/portal routes and pre-guard special cases above
  `app.use('/api/*', ...apiAuth())`).
- `wrangler.toml`: add every binding the code uses (R2, D1, KV, `send_email`, service
  bindings, workflow bindings with `script_name`, `[vars]`) for dev, test and production,
  copying the values from app-api's `wrangler.toml`. Crons the module owns go to its
  `[triggers]` and a `scheduled()` handler.
- Secrets: add the module's secrets to its entry in `scripts/secrets/manifest.ts`. Only
  remove one from `"app-api"` when nothing left in app-api reads it. Secrets app-api has
  that are **not** in the manifest (set by hand): list them in the worker's
  `wrangler.toml` header under `# Secrets (not in the manifest yet):`.
- Tests: the scaffolded `src/routes/_sweeps.test.ts` gets (a) the module's cases moved
  out of app-api's `_auth-gates.test.ts` and `_list-endpoint-sweep.test.ts`, and (b) an
  entity-event coverage check with the module's entries moved out of app-api's
  `_event-coverage.test.ts` `EXEMPT_ROUTES` — all via `@weldsuite/worker-kit/testing/sweeps`
  (it already has the entity-event coverage check).
- Reference: `apps/workers/know-api` (smallest) and `apps/workers/pass-api`.

## 5. app-api

- `node scripts/api-module-cutover.mjs <module>`: adds the `<MODULE>_API` service binding
  in dev/test/production, appends the module to `API_FORWARD_MODULES` in all three
  `[vars]`, and adds `<MODULE>_API?: Fetcher` to app-api's `Env`.
- By hand, `src/index.ts`: remove the module's imports, mounts, cron calls and queue
  handling. Drop a cron expression from `[triggers]` only when nothing in app-api uses it.
- `src/types.ts`: remove bindings/secrets nothing in app-api uses any more.

## 6. Verify (all must pass before you report)

```bash
pnpm install
pnpm --filter <module>-api type-check && pnpm --filter <module>-api test
cd apps/workers/app-api && NODE_OPTIONS=--max-old-space-size=8192 pnpm type-check && pnpm test
pnpm --filter "./packages/core/api-modules" --filter "./packages/core/worker-*" --filter "./packages/domains/*" test
# plus type-check of every package you created or changed
cd apps/workers/<module>-api && pnpm exec wrangler deploy --dry-run --env test --outdir <tmp>
cd apps/workers/<module>-api && pnpm exec wrangler deploy --dry-run --env production --outdir <tmp>
cd apps/workers/app-api && pnpm exec wrangler deploy --dry-run --env test --outdir <tmp>
```

## Rules

- If `pnpm install` rewrites unrelated lockfile lines (React Native peer strings),
  restore `pnpm-lock.yaml` and run `pnpm install --lockfile-only --prefer-offline`,
  then `pnpm install --frozen-lockfile --prefer-offline`.

- No behaviour changes, no refactors beyond what the move needs.
- No migrations, no `any`, no `@ts-ignore`, no new `console.log`; Zod v3.
- Never edit `apps/web/platform/src/routeTree.gen.ts`.
- Do not commit; report instead: files moved, packages created/changed, bindings,
  secrets (incl. hand-set ones), anything you could not resolve.
