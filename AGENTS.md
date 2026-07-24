# AGENTS.md

The authoritative map of this monorepo (modules, routing, API/DB conventions,
commands) lives in [CLAUDE.md](./CLAUDE.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).
Read those first. This file only adds cloud-environment caveats.

## Cursor Cloud specific instructions

Toolchain is already provisioned (Node 22, pnpm 10.4.1). The startup update
script runs `pnpm install`; you normally don't need to reinstall.

### Big picture: source-visible, not self-hostable
Per the README, the hosted product depends on external services (Clerk, Neon
Postgres, Cloudflare account resources, Stripe) that **nothing in this repo
provisions** — `wrangler.toml`/`.env.example` are templates with
`REPLACE_WITH_*` placeholders. Consequences for local dev:

- The **platform SPA renders a blank page** unless `VITE_CLERK_PUBLISHABLE_KEY`
  is set (Clerk's `ClerkProvider` throws `Missing publishableKey` and blocks the
  whole React tree). Even with a key, signing in and loading any module data
  additionally requires a real Clerk instance **and** a provisioned Neon master
  DB + tenant workspace. So you cannot drive a logged-in UI flow locally without
  the private overlay's secrets.
- `apps/web/platform/.env.example` is **stale** (describes a retired
  Keycloak/NextAuth/Mailcow stack). Trust the code (`VITE_*` vars), not that file.

### Best offline verification path (no external services)
The backend has a full in-memory Postgres (`@electric-sql/pglite`) test harness.
This is the strongest way to exercise real route → service → Drizzle → schema
logic locally:

- `pnpm --filter app-api test`  — ~684 integration/unit tests, all offline.
- `pnpm --filter platform test` — component/unit tests (Vitest + jsdom).

### Running the backend worker locally
Plain `pnpm dev` (i.e. `wrangler dev`) **fails** with "You must be logged in to
use wrangler dev in remote mode" because `wrangler.toml` marks the `FLAGSHIP`,
`REALTIME`, and `WORKSPACE_WORKER` bindings `remote = true`. Run fully local
instead (those three bindings become unavailable, which is fine for most work):

```
cd apps/workers/app-api && pnpm exec wrangler dev --port 8789 --local
```

Sanity checks once it's up: `GET /robots.txt` → 200, `GET /health` → 503 with a
"no database connection string" message (expected without Neon), `GET /api/*` →
401 without a Clerk JWT (auth guard working).

### Platform type-check needs a bigger heap
`pnpm --filter platform type-check` (`tsc --noEmit`) OOMs at Node's default heap.
Run it with more memory:

```
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter platform type-check
```

`pnpm --filter platform build` (Vite) does **not** need this and passes on its
own. Note: the platform type-check currently surfaces some pre-existing TS
errors unrelated to environment setup.

### Lint
Most quality gating for `platform`/`app-api` is `type-check` + tests (they have
no `lint` script). Packages that do define real ESLint (e.g. `@weldsuite/db`,
`@weldsuite/ui`) run via `pnpm --filter <name> lint`. `pnpm lint` at the root
fans out through Turborepo.

### Default dev ports
platform 3000, app-api 8789, realtime-worker 8790, billing-worker 8788.
