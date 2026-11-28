# Admin console

The staff console for WeldSuite: workspaces, WeldReach access, the app
catalog, plans, outbound mail, warm-up, WeldForms moderation, staff, feature
flags and the activity log. TanStack Start (ADR FE-018), built as a Node
server for the Kubernetes editions (EU, self-hosted).

- **Host:** `admin.<domain>`, behind an IP allowlist.
- **Sign-in:** OIDC (Zitadel, or WeldID). An account gets in only with an
  active `admin_users` row bound to it (`console_subject`). With
  `ADMIN_OIDC_ORG_ID` set (Zitadel, ADR SEC-018), only an account of that
  staff organization gets in; unset (WeldID, SEC-019), its separate staff
  issuer guarantees that on its own.
- **Databases:** Postgres over TCP. Tenant URLs come from the sealed
  `database_url` in the master database.
- **Email:** SMTP (`SMTP_URL`).

`pnpm build` bundles every dependency into `dist/`, so the image needs no
`node_modules`. `scripts/check-node-build.mjs` fails the build if Clerk, the
Neon driver or a Cloudflare runtime module ends up in it.

## Local

```bash
cp apps/web/admin/.env.example apps/web/admin/.env   # then fill it in
pnpm --filter admin dev      # http://localhost:3001
pnpm --filter admin test
pnpm --filter admin build && pnpm --filter admin start:node
```

`.env.example` lists every variable.

## Kubernetes

The image (`rust/Dockerfile`, target `admin`) runs `pnpm build:node`, the same
build as `pnpm build`. The Helm chart's `admin` block
(`rust/deploy/helm/weldsuite`) runs it; `rust/deploy/hetzner/README.md` ("The
admin console") has the Zitadel app, secrets, allowlist and first-superadmin
steps.

Global's console (a Cloudflare Worker with Clerk sign-in) was removed after
Global's workspaces moved into EU production (ADR OPS-025).

`vercel.json` only switches off the Git builds of the old Vercel project
(`weldsuite-admin`); delete it once that project is archived.
