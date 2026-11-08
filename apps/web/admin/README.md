# Admin console

The staff console for WeldSuite: workspaces, WeldReach access, the app
catalog, plans, outbound mail, warm-up, activity, and on Global the pricing,
database, partner and support screens. TanStack Start (ADR FE-018), built two
ways from the same code.

| | Global | Kubernetes editions (EU, self-hosted) |
|---|---|---|
| Build | `pnpm build` (Cloudflare Worker) | `pnpm build:node` (Node server, image `weldsuite-admin`) |
| Host | `admin.weldsuite.org`, `admin-test.weldsuite.org` | `admin.<domain>`, behind an IP allowlist |
| Sign-in | the console's own invite-only Clerk instance (ADR SEC-009), role in public metadata | OIDC (Zitadel), let in by an active `admin_users` row |
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

## Global: moving the console from Vercel to the Worker

`deploy.yml`'s `frontend-admin` job deploys the Worker only to the
environments named in the repository variable `ADMIN_WORKER_ENVS`. Until then
that environment's console stays on Vercel. Per environment, test first:

1. Put `ADMIN_CLERK_SECRET_KEY` and `ADMIN_CLERK_PUBLISHABLE_KEY` (the admin
   Clerk instance's keys, not the product's) and `CF_EMAIL_SEND_TOKEN` in
   Doppler, then `pnpm secrets:sync test admin`.
2. In the admin Clerk instance, add the host to the allowed origins and
   redirect URLs.
3. Delete the hostname's DNS record in the `weldsuite.org` zone (it points at
   Vercel). The Worker's custom domain can't be created while it exists.
4. Add the environment to `ADMIN_WORKER_ENVS` (`test`, later
   `test,production`) and run the Deploy workflow, or push a console change.
5. Check: sign in, a viewer is refused a write, one write per area, and a
   cross-site POST is refused.

For production, keep the Vercel project `weldsuite-admin` for a week as the
way back (restore the DNS record), then delete it.

## Kubernetes

The Helm chart's `admin` block (`rust/deploy/helm/weldsuite`) runs the image;
`rust/deploy/hetzner/README.md` ("The admin console") has the Zitadel app,
secrets, allowlist and first-superadmin steps.
