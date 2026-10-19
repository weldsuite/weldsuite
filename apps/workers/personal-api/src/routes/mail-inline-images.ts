/**
 * Inline images of personal mail — GET /public/mail-inline/:token (TASK-905).
 *
 * The personal twin of mail-api's route of the same path. No Clerk session:
 * an `<img>` in the reading pane cannot send a bearer, so the token is the
 * authorisation. personal-api mints it when the owner reads the message, and
 * it is sealed, bound to one attachment under that personal account's folder
 * and expires within about an hour.
 *
 * Personal tokens only (a workspace token is mail-api's), images only, under
 * a sandboxing CSP. Anything that does not check out is a plain 404.
 */

import { Hono } from 'hono';
import {
  isInlineImageType,
  isOwnedStorageKey,
  openInlineImageToken,
} from '@weldsuite/mail-domain/inline-images';
import { error } from '../lib/response';
import { inlineImageSecret } from '../lib/inline-images';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:token', async (c) => {
  const secret = inlineImageSecret(c.env);
  if (!secret || !c.env.STORAGE) return error.notFound(c, 'Image', 'inline');

  const claims = await openInlineImageToken(secret, c.req.param('token'));
  if (!claims || claims.p === undefined || !isOwnedStorageKey(claims, claims.k) || !isInlineImageType(claims.t)) {
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
