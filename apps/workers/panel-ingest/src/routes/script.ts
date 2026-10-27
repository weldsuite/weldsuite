/**
 * `GET /s.js`: the browser SDK, the same bundle for every project. The
 * project comes from the snippet's `data-project` attribute, not from this
 * URL, so the response is identical for everyone and cacheable.
 *
 * The bundle is a build artefact (`pnpm --filter @weldsuite/panel-sdk build`)
 * pulled in as a text module by the `[[rules]]` entry in wrangler.toml, which
 * is why the deploy scripts build the SDK first.
 */

import { Hono } from 'hono';
import panelSdkSource from '@weldsuite/panel-sdk/dist/panel.global.js';
import type { Env } from '../env';

let etag: Promise<string> | undefined;

/** A strong validator derived from the bundle, so a redeploy with an unchanged SDK keeps browser caches valid. */
function bundleEtag(): Promise<string> {
  etag ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(panelSdkSource)).then((digest) => {
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return `"${hex.slice(0, 32)}"`;
  });
  return etag;
}

/** `If-None-Match` is a list of validators or `*`; weak ones compare equal for GET. */
function matchesEtag(header: string | undefined, current: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === current);
}

export const scriptRoutes = new Hono<{ Bindings: Env }>();

scriptRoutes.get('/s.js', async (c) => {
  const tag = await bundleEtag();
  const headers = {
    'Cache-Control': 'public, max-age=3600',
    ETag: tag,
  };
  if (matchesEtag(c.req.header('If-None-Match'), tag)) return c.body(null, 304, headers);
  return c.body(panelSdkSource, 200, { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' });
});
