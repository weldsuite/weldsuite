/**
 * WeldPass audit trail.
 *
 * Deliberately separate from the shared entity-event bus: that bus feeds
 * workflows, analytics and AI agents, and neither secret metadata nor
 * production credential names belong in any of them. Reveals are recorded
 * alongside writes — for a secrets manager, "who read this" matters as much as
 * "who changed it". Only key names and metadata are stored; a value never
 * reaches this table.
 *
 * Failures here are logged and swallowed: a broken audit write must not take
 * down the request that caused it, and the caller has usually already
 * committed. Losing the trail silently would be worse, so the log line is
 * deliberately loud.
 */

import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

export type WeldPassAuditAction =
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'environment.created'
  | 'environment.updated'
  | 'environment.deleted'
  | 'secret.created'
  | 'secret.updated'
  | 'secret.deleted'
  | 'secret.restored'
  | 'secret.revealed'
  | 'secret.exported'
  | 'secrets.imported'
  | 'credential.created'
  | 'credential.updated'
  | 'credential.deleted'
  | 'credential.verified'
  | 'sync_target.created'
  | 'sync_target.updated'
  | 'sync_target.deleted'
  | 'sync.pushed'
  | 'sync.failed';

export interface WeldPassAuditEntry {
  projectId: string;
  environmentId?: string | null;
  secretId?: string | null;
  actorId: string;
  action: WeldPassAuditAction;
  /** Secret key or target name. Never a value. */
  targetKey?: string | null;
  metadata?: Record<string, unknown>;
}

/** Request identity for the trail, read once per request. */
export interface WeldPassAuditContext {
  ip: string | null;
  userAgent: string | null;
}

export function auditContextFrom(headers: Headers): WeldPassAuditContext {
  return {
    ip: headers.get('CF-Connecting-IP') ?? headers.get('X-Forwarded-For') ?? null,
    userAgent: headers.get('User-Agent')?.slice(0, 500) ?? null,
  };
}

export async function recordAudit(
  db: Database,
  context: WeldPassAuditContext,
  entry: WeldPassAuditEntry,
): Promise<void> {
  try {
    await db.insert(schema.weldpassAuditEvents).values({
      id: generateId('wpa'),
      projectId: entry.projectId,
      environmentId: entry.environmentId ?? null,
      secretId: entry.secretId ?? null,
      actorId: entry.actorId,
      action: entry.action,
      targetKey: entry.targetKey ?? null,
      metadata: entry.metadata ?? {},
      ip: context.ip,
      userAgent: context.userAgent,
    });
  } catch (err) {
    console.error('[weldpass] audit write failed', {
      action: entry.action,
      projectId: entry.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
