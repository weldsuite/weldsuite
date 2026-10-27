/**
 * Token → project. The only place the collector reads project state: the KV
 * record panel-api keeps in step with the tenant row and the master registry
 * (ADR PANEL-001). No database is ever opened here.
 */

import { parseProjectRecord, projectKvKey, type PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { withSettingDefaults } from '@weldsuite/panel-domain/settings';
import { isProjectToken } from '@weldsuite/panel-domain/tokens';
import type { Env } from '../env';

/**
 * KV may serve a record up to this many seconds old (its minimum edge cache),
 * so a paused project or a rotated token takes about a minute to be noticed.
 */
const KV_CACHE_TTL = 60;

/** The project a token names, settings filled in; null for a malformed, unknown or deleted token. */
export async function loadProject(env: Pick<Env, 'WORKSPACE_CACHE'>, token: string): Promise<PanelProjectRecord | null> {
  // A bad token shape can never be a key: no need to ask KV.
  if (!isProjectToken(token)) return null;
  const raw = await env.WORKSPACE_CACHE.get(projectKvKey(token), { cacheTtl: KV_CACHE_TTL });
  const record = parseProjectRecord(raw);
  return record ? { ...record, settings: withSettingDefaults(record.settings) } : null;
}
