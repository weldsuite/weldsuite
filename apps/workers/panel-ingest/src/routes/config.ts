/**
 * `GET /c/:token`: what the SDK needs before it collects anything. Public and
 * write-free: the token is already in the page source, and the answer holds
 * nothing but the project's collection settings.
 */

import { Hono } from 'hono';
import type { ClientConfig } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { loadProject } from '../lib/project';

export const configRoutes = new Hono<{ Bindings: Env }>();

configRoutes.get('/c/:token', async (c) => {
  const project = await loadProject(c.env, c.req.param('token'));
  if (!project) {
    // Not cached: a project created a moment ago must not stay unknown for minutes.
    return c.json({ error: { code: 'unknown_project', message: 'Unknown project token' } }, 404, {
      'Cache-Control': 'no-store',
    });
  }

  const { autocapture, consentMode, maskingLevel, excludedUrls } = project.settings;
  const config: ClientConfig = { autocapture, consentMode, maskingLevel, excludedUrls };
  return c.json(config, 200, { 'Cache-Control': 'public, max-age=300' });
});
