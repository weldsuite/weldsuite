/**
 * Audit Log Helper for Helpdesk Widget API
 */

import { schema } from '../db';
import { generateId } from './id';

export async function insertAuditLog(
  db: any,
  params: {
    entityType: string;
    entityId: string;
    action: string;
    description: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
    performedBy?: string;
    performedByName?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await db.insert(schema.auditLogs).values({
      id: generateId('aud'),
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      description: params.description,
      changes: params.changes,
      performedBy: params.performedBy,
      performedByName: params.performedByName,
      metadata: params.metadata,
    });
  } catch (err) {
    console.error('[AuditLog] Failed to insert audit log:', err);
  }
}
