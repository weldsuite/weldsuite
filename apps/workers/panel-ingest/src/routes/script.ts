/**
 * `GET /s.js` (the browser SDK) and `GET /rec.js` (its recording plugin): the
 * same bundles for every project. The project comes from the snippet's
 * `data-project` attribute, not from these URLs, so each response is identical
 * for everyone and cacheable. The core loads `/rec.js` only when the visitor
 * consented, the session is sampled, `GET /c/:token` says recording isn't
 * blocked and the page isn't excluded.
 *
 * The bundles are build artefacts (`pnpm --filter @weldsuite/panel-sdk build`)
 * pulled in as text modules by the `[[rules]]` entry in wrangler.toml, which
 * is why the deploy scripts build the SDK first.
 */

import { Hono } from 'hono';
import panelRecorderSource from '@weldsuite/panel-sdk/dist/panel-recorder.global.js';
import panelSdkSource from '@weldsuite/panel-sdk/dist/panel.global.js';
import type { Env } from '../env';

/** A strong validator derived from the bundle, so a redeploy with an unchanged SDK keeps browser caches valid. */
function etagOf(source: string): () => Promise<string> {
  let etag: Promise<string> | undefined;
  return () => {
    etag ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)).then((digest) => {
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      return `"${hex.slice(0, 32)}"`;
    });
    return etag;
  };
}

/** `If-None-Match` is a list of validators or `*`; weak ones compare equal for GET. */
function matchesEtag(header: string | undefined, current: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === current);
}

export const scriptRoutes = new Hono<{ Bindings: Env }>();

function serveBundle(path: string, source: string): void {
  const bundleEtag = etagOf(source);
  scriptRoutes.get(path, async (c) => {
    const tag = await bundleEtag();
    const headers = {
      'Cache-Control': 'public, max-age=3600',
      ETag: tag,
    };
    if (matchesEtag(c.req.header('If-None-Match'), tag)) return c.body(null, 304, headers);
    return c.body(source, 200, { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' });
  });
}

serveBundle('/s.js', panelSdkSource);
serveBundle('/rec.js', panelRecorderSource);
