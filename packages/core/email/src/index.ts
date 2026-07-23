/**
 * @weldsuite/email — provider-agnostic email stack.
 *
 * Public API:
 *   import { getSendProvider, getDomainProvider } from '@weldsuite/email';
 *   import { registerCloudflareProvider } from '@weldsuite/email/providers/cloudflare';
 *
 * Each consuming worker should:
 *   1. Import the provider modules it needs (Cloudflare for our default,
 *      Gmail/Outlook for OAuth-connected mailboxes).
 *   2. Call their `register*` function during bootstrap, passing the
 *      worker's env so the provider can grab its bindings/secrets.
 *   3. Resolve providers via `getSendProvider(name?)` etc. — never import
 *      a provider's internal classes directly.
 */

export * from './core/types';
export * from './core/errors';
export * from './core/registry';
export * from './core/parse';
export * from './core/mime';
