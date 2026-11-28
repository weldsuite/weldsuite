# Admin console

The staff console for WeldSuite: workspaces, WeldReach access, the app
catalog, plans, outbound mail, warm-up, activity, and on Global the pricing,
database, partner and support screens. TanStack Start (ADR FE-018), built two
ways from the same code.

| | Global | Kubernetes editions (EU, self-hosted) |
|---|---|---|
| Build | `pnpm build` (Cloudflare Worker) | `pnpm build:node` (Node server, image `weldsuite-admin`) |
| Host | `admin.weldsuite.org`, `admin-test.weldsuite.org` | `admin.<domain>`, behind an IP allowlist |
| Sign-in | the console's own invite-only Clerk instance (ADR SEC-009), role in public metadata | OIDC (Zitadel, or WeldID) let in by an active `admin_users` row bound to the account (`console_subject`). With `ADMIN_OIDC_ORG_ID` set (Zitadel, ADR SEC-018), only an account of that staff organization; unset (WeldID, SEC-019), its separate staff issuer guarantees that on its own |
| Databases | Neon HTTP; tenant URLs resolved through the Neon API | Postgres over TCP; tenant URLs from the sealed `database_url` |
| Email | Cloudflare Email REST, else Resend | SMTP (`SMTP_URL`) |
| Pages | all | Global-only pages answer 404; adds Staff and Feature flags |

`lib/edition.ts` decides which pages and server functions exist, from the
build mode. The Node build swaps five modules for their `.node.ts` siblings
(`vite.config.ts`); `scripts/check-node-build.mjs` fails the build if Clerk or
the Neon driver ends up in it.

## Local

```bash
pnpm secrets:dev admin       # from the repo root: writes .dev.vars from Doppler
pnpm --filter admin dev      # http://localhost:3001, against the test workers
pnpm --filter admin test
pnpm --filter admin build:node && pnpm --filter admin start:node
```

`.env.example` lists every variable, the Node-only ones at the end.

## Global

Global's console (the Vercel project `weldsuite-admin` and the Worker build)
is no longer deployed: Global's deploy was removed on 2026-11-28, after its
workspaces moved into EU production (ADR OPS-025). The console runs on
Kubernetes.

## Kubernetes

The Helm chart's `admin` block (`rust/deploy/helm/weldsuite`) runs the image;
`rust/deploy/hetzner/README.md` ("The admin console") has the Zitadel app,
secrets, allowlist and first-superadmin steps.
