/**
 * `GET /c/:token`: what the SDK needs before it collects anything. Public and
 * write-free: the token is already in the page source, and the answer holds
 * nothing but the project's collection settings, the recording switch and the
 * snapshot the project is waiting for.
 */

import { Hono } from 'hono';
import { parseSnapshotRequest, snapshotRequestKvKey } from '@weldsuite/panel-domain/registry';
import type { ClientConfig } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { loadProject } from '../lib/project';
import { quotaState } from '../lib/quota';

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
  const sampleRate = Math.min(Math.max(Number(project.settings.recordingSampleRate) || 0, 0), 1);
  const [quota, snapshotRaw] = await Promise.all([
    quotaState(c.env.WORKSPACE_CACHE, project.workspaceId, Date.now()),
    c.env.WORKSPACE_CACHE.get(snapshotRequestKvKey(project.projectId), { cacheTtl: 60 }),
  ]);

  const config: ClientConfig = {
    autocapture,
    consentMode,
    maskingLevel,
    excludedUrls,
    recordingSampleRate: sampleRate,
    // Recordings are off by setting (rate 0) or by quota (any blocked state: events_blocked blocks them too).
    recordingBlocked: sampleRate === 0 || quota !== 'ok',
    snapshot: parseSnapshotRequest(snapshotRaw),
  };
  return c.json(config, 200, { 'Cache-Control': 'public, max-age=300' });
});
