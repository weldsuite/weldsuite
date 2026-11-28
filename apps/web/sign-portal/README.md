# sign-portal — WeldSign signer portal

Where people outside a workspace open and sign documents sent with WeldSign
(`sign.<domain>`, and `sign.weldsuite.org` as an alias). Signers have no
account: they open a personal link, `/r/<token>`, from the request email.

TanStack Start on Node, Tailwind v4, `@weldsuite/ui`. The portal is a thin
client of the Rust backend (ADR FE-017): its server routes call the backend's
`/public/sign-portal/*` endpoints at `SIGN_PORTAL_BACKEND_URL`, with the shared
`SIGN_PORTAL_SECRET` and the signer's IP from `X-Forwarded-For`
(`SIGN_PORTAL_TRUSTED_PROXIES` proxies counted from the right, 1 for the
ingress). `SIGN_PORTAL_BACKEND=rust` is required.

| Route | Operation |
| --- | --- |
| `POST /api/session`, `/api/verify` | open a link (and check its code); on `ready` the signer session goes into an httpOnly cookie per link |
| `POST /api/resend-code` | email a fresh code |
| `GET /api/portal/envelope`, `/documents/<id>`, `/download`, `/evidence` | what the signer sees, the PDFs |
| `POST /api/portal/consent`, `/complete`, `/decline` | the signer's steps |
| `POST /api/portal/signature/{start,finish,cancel}`, `GET /signature-callback` | advanced and qualified signatures (eIDAS) through a trust service provider |

Layout: pages and server routes in `src/routes/`, the signer UI in
`components/` (all client-side), server-only code in `lib/server/`: the
routes run the operations through `signer-portal.ts`, which uses the HTTP
client in `portal-client.ts`.

`pnpm build` (the image runs `build:node`, the same) writes a Node server to
`dist/` with every dependency bundled; `node node/server.mjs` serves it
(`PORT`, `/healthz` for the probes). The image is the `sign-portal` target of
`rust/Dockerfile`; the Helm chart in `rust/deploy/helm/weldsuite` runs it
(`signPortal.*`).

## Running locally

```bash
# terminal 1: the Rust server (see rust/README.md)
# terminal 2: this app, against it
SIGN_PORTAL_BACKEND=rust SIGN_PORTAL_BACKEND_URL=http://localhost:8080 \
SIGN_PORTAL_SECRET=<the server's SIGN_PORTAL_SECRET> \
pnpm --filter sign-portal dev        # http://localhost:3023
```

```bash
pnpm --filter sign-portal test
pnpm --filter sign-portal build && pnpm --filter sign-portal start:node
```
