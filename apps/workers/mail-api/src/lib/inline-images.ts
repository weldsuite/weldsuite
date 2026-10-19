/**
 * Inline-image URLs for the messages mail-api returns (TASK-905). See
 * `@weldsuite/mail-domain/inline-images` for the token and the HTML rewrite.
 */

import type { Context } from 'hono';
import { inlineImageSecret, type InlineImageSigner } from '@weldsuite/mail-domain/inline-images';
import type { Env, Variables } from '../types';

// The send path opens the same tokens, so the secret is resolved in the domain.
export { inlineImageSecret };

/**
 * The signer a reading route passes to getMessage / getThread. Undefined
 * without a secret: the HTML then keeps its `cid:` references (images do not
 * show, and no public URL is handed out).
 */
export function inlineImageSigner(c: Context<{ Bindings: Env; Variables: Variables }>): InlineImageSigner | undefined {
  const secret = inlineImageSecret(c.env);
  if (!secret) {
    console.warn('[mail-api] no inline-image secret; inline images are not rewritten');
    return undefined;
  }
  return {
    workspaceId: c.get('workspaceId'),
    // The worker's own public origin: a request forwarded by app-api carries
    // app-api's host, which does not serve /public/mail-inline.
    baseUrl: c.env.MAIL_API_PUBLIC_URL || new URL(c.req.url).origin,
    secret,
  };
}
