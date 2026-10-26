# sign-portal — WeldSign signer portal

Where people outside a workspace open and sign documents sent with WeldSign
(`sign.weldsuite.org`, `sign-test.weldsuite.org`). Signers have no account:
they open a personal link, `/r/<token>`, from the request email.

TanStack Start on a Cloudflare Worker, Tailwind v4, `@weldsuite/ui`. There is
no API in between (ADR FE-016): the portal runs the signer side of WeldSign
itself, on the same domain code as sign-api, `@weldsuite/sign-domain/portal`.
Its own server routes call it with the Worker's bindings:

| Route | Operation |
| --- | --- |
| `POST /api/session`, `/api/verify` | open a link (and check its code); on `ready` the signer session goes into an httpOnly cookie per link |
| `POST /api/resend-code` | email a fresh code |
| `GET /api/portal/envelope`, `/documents/<id>`, `/download` | what the signer sees, the PDFs |
| `POST /api/portal/consent`, `/complete`, `/decline` | the signer's steps |

The domain code finds the workspace from the link token (master
`sign_link_registry`), opens its tenant DB, reads and writes WeldSign files in
R2, emails codes, publishes `sign_envelope` events, and starts sign-api's
`FinalizeEnvelopeWorkflow` (bound by `script_name`) after the last signature.
The signer's IP on the evidence trail is `CF-Connecting-IP`, read at the edge.
See `docs/plans/weldsign.md`.

Layout: pages and server routes in `src/routes/`, the signer UI in
`components/` (all client-side, as before), server-only code in
`lib/server/`.

## Running locally

```bash
# terminal 1 — the API workers (sign-api creates links, sends, finalizes)
pnpm dev:api                         # app-api on http://localhost:8789

# terminal 2 — this app
pnpm --filter sign-portal dev        # http://localhost:3023
```

The portal's local KV, R2 and D1 are `pnpm dev:api`'s
(`vite.config.ts` → `persistState`), so a link sent from a local sign-api opens
here. Local dev has no `FINALIZE_ENVELOPE` binding: the portal builds the
signed PDF itself in `waitUntil`.

Secrets go in `.dev.vars` (`pnpm secrets:dev sign-portal` writes it from
Doppler): `DATABASE_URL_MASTER`, `NEON_API_KEY`, `DATABASE_ENCRYPTION_KEY` and
`SIGN_SESSION_SECRET`, the same value as sign-api's (sign-api hashes access
codes with it; the portal checks them and signs the sessions).

## Deploy

Workers `weldsuite-sign-portal-test` (route `sign-test.weldsuite.org/*`) and
`weldsuite-sign-portal` (route `sign.weldsuite.org/*`), released only by
`deploy.yml` (`frontend-sign-portal`): a push to `develop` that touches this
app or a package it runs deploys test, a push to `main` production. The build
picks the wrangler environment (`CLOUDFLARE_ENV=test pnpm build`); the deploy
is a plain `wrangler deploy`. It runs after the workers job, because it binds
sign-api's Workflow.

Secrets: `pnpm secrets:sync <test|production> sign-portal` (manifest entry
`sign-portal`). sign-api's `SIGN_PORTAL_URL` points signing links at these
hosts. `vercel.json` only switches off the old Vercel project's Git builds;
remove it when that project is archived.
