/**
 * Fire-and-forget WeldDesk notifications for the routes: "assigned to you" and
 * "customer replied". The helpers live in `@weldsuite/notifications` (they read
 * the workspace's `notifyOnAssignment` / `notifyOnCustomerReply` settings and
 * skip self-assignment); this wrapper only hands them to
 * `executionCtx.waitUntil` so a notification can never slow down or fail the
 * response that triggered it.
 */

import type { Context } from 'hono';
import {
  sendTicketAssignedNotification,
  type HelpdeskEntityKind,
} from '@weldsuite/notifications';
import type { Env, Variables } from '../types';

type DeskContext = Context<{ Bindings: Env; Variables: Variables }>;

interface NotifyAssignedParams {
  /** The new assignee. Null/undefined/'' (an unassign) sends nothing. */
  assigneeId: string | null | undefined;
  /** Assignee before this change; an unchanged assignee sends nothing. */
  previousAssigneeId?: string | null;
  kind: HelpdeskEntityKind;
  entityId: string;
  subject?: string | null;
  reference?: string | null;
  /** Who made the change; null for the system (department auto-assignment). */
  assignedByUserId: string | null;
}

/** Notify the new assignee of a conversation/ticket, in the background. */
export function notifyAssigned(c: DeskContext, params: NotifyAssignedParams): void {
  const { assigneeId, previousAssigneeId, kind, entityId, subject, reference, assignedByUserId } = params;
  if (!assigneeId || assigneeId === previousAssigneeId) return;

  c.executionCtx.waitUntil(
    sendTicketAssignedNotification({
      db: c.get('tenantDb'),
      env: c.env,
      // The notification helpers key realtime topics and email links by the Clerk org id.
      workspaceId: c.get('clerkOrgId'),
      assigneeId,
      assignedByUserId,
      kind,
      entityId,
      subject,
      reference,
    }).catch((err) => console.error('[desk-api/notify] assignment notification failed:', err)),
  );
}
