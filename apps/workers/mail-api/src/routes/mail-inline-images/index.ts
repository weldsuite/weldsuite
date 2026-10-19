/**
 * Inline images of mail messages — GET /public/mail-inline/:token (TASK-905).
 *
 * No Clerk session: an `<img>` in the reading pane cannot send a bearer. The
 * token is the authorisation. mail-api mints it when a member who may open
 * the mailbox reads the message (getMessage / getThread), and it is sealed,
 * bound to one workspace attachment and expires within about an hour.
 *
 * Only images are served, under a sandboxing CSP, so a token can never put
 * HTML or script on the API origin. Anything that does not check out is a
 * plain 404.
 */

import { Hono } from 'hono';
import { error } from '@weldsuite/worker-kit/response';
import { isWorkspaceStorageKey } from '@weldsuite/mail-domain/attachments';
import { isInlineImageType, openInlineImageToken } from '@weldsuite/mail-domain/inline-images';
import { inlineImageSecret } from '../../lib/inline-images';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:token', async (c) => {
  const secret = inlineImageSecret(c.env);
  if (!secret || !c.env.STORAGE) return error.notFound(c, 'Image', 'inline');

  const claims = await openInlineImageToken(secret, c.req.param('token'));
  if (!claims || !isWorkspaceStorageKey(claims.k, claims.w) || !isInlineImageType(claims.t)) {
    return error.notFound(c, 'Image', 'inline');
  }

  const object = await c.env.STORAGE.get(claims.k);
  if (!object) return error.notFound(c, 'Image', 'inline');

  const maxAge = Math.max(0, claims.e - Math.floor(Date.now() / 1000));
  return new Response(object.body, {
    headers: {
      'Content-Type': claims.t,
      'Cache-Control': `private, max-age=${maxAge}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
});

export { app as mailInlineImagesRoutes };
