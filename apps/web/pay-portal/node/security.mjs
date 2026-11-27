// The page's Content-Security-Policy, for node/server.mjs, which runs without
// the app's TypeScript (lib/security.test.ts tests this file).
//
// A script runs only when it carries this request's nonce (TanStack Start
// stamps it on its own scripts: server.mjs hands it over as the request's
// context), and what such a script loads is allowed ('strict-dynamic'). There
// is no `unsafe-inline` for scripts or styles, no third-party origin, and the
// page talks to its own origin alone: the backend is called on the server.
// Images may come from any https address because the seller's logo is one;
// nothing else loads from elsewhere.

import { randomBytes } from 'node:crypto'

/** A fresh nonce for one response. */
export function newNonce() {
  return randomBytes(16).toString('base64')
}

/** @param {string} nonce */
export function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
