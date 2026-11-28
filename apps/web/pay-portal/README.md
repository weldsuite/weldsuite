# pay-portal

WeldBooks' public page for one invoice or quote, at `pay.<domain>/d/<token>`. A
customer opens the link from the email, views the document, downloads the PDF,
pays an invoice online (Mollie) or accepts a quote. The token in the link is
the only credential. TanStack Start on Node, Kubernetes only, dev port 3033.

## Routes

| Path | What |
|---|---|
| `/` | A short explanation, for someone who arrives without a link |
| `/d/$token` | The document, with Pay now or Accept quote when they apply |
| `/d/$token/return` | Where Mollie sends the customer back: received, pending or not completed |
| `/d/$token/pdf` | The PDF, streamed from the backend |
| `/healthz` | Liveness, served by `node/server.mjs` |

## Backend

The portal calls the WeldSuite server's unauthenticated
`/public/weldbooks/documents/{token}` routes (contract in `lib/contract.ts`,
calls in `lib/server/backend.ts`). The browser never sees the backend's
address: every call is a server function.

## Environment

| Variable | |
|---|---|
| `PAY_PORTAL_BACKEND_URL` | Required. The server's base URL, for example `http://localhost:8789` |
| `PAY_PORTAL_PUBLIC_URL` | Optional. This portal's own origin, where Mollie returns the customer. Taken from `Host` and `X-Forwarded-Proto` when unset |
| `PORT`, `HOST` | Optional. Default 3000 and `0.0.0.0` |

There is no secret.

## Security

The token is never logged and never in a query string. Every response is
`no-store`, `noindex`, unframed and sends `Referrer-Policy: no-referrer`. The
Content-Security-Policy carries a per-response nonce (`node/security.mjs`):
`node/server.mjs` sets it on the request as `x-csp-nonce` (replacing any value
the client sent) and `src/router.tsx` passes it to Start's `ssr.nonce`, which
stamps it on every inline script, the module script and the preload links.
When you change either side, check the built HTML still has a nonce on every
`<script>` and modulepreload `<link>`.

## Commands

```bash
pnpm --filter pay-portal dev          # port 3033
pnpm --filter pay-portal build
pnpm --filter pay-portal start:node   # after build
pnpm --filter pay-portal test
pnpm --filter pay-portal type-check
pnpm --filter pay-portal lint
```

Copy is in `lib/i18n.ts` (`en` and `nl`); the document's own language wins,
the browser's `Accept-Language` decides otherwise.
