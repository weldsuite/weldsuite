import 'server-only';

import { sendSystemEmail } from '@weldsuite/emails';
import { transportFromEnv } from '@weldsuite/emails/transports/env';

/**
 * Best-effort transactional emails for admin-scheduled workspace deletion.
 * Never throw — a mail failure must not block the scheduling/cancel action. If
 * no transport is configured (e.g. local dev), these no-op with a warning.
 */
async function send(
  to: string[],
  kind: 'scheduled' | 'cancelled',
  props: { workspaceName: string; deletionAt?: string | null; reason?: string | null },
): Promise<void> {
  if (to.length === 0) return;
  const transport = transportFromEnv(process.env);
  if (!transport) {
    console.warn('[admin/workspace-deletion-email] no email transport configured — skipping email');
    return;
  }
  try {
    await sendSystemEmail(transport, {
      template: 'admin.workspace-deletion',
      props: { kind, ...props },
      to,
    });
  } catch (err) {
    console.error('[admin/workspace-deletion-email] Failed to send email:', err);
  }
}

export async function sendDeletionScheduledEmail(
  to: string[],
  params: { workspaceName: string; deletionAtIso: string; reason?: string | null },
): Promise<void> {
  await send(to, 'scheduled', {
    workspaceName: params.workspaceName,
    deletionAt: params.deletionAtIso,
    reason: params.reason,
  });
}

export async function sendDeletionCancelledEmail(
  to: string[],
  params: { workspaceName: string },
): Promise<void> {
  await send(to, 'cancelled', { workspaceName: params.workspaceName });
}
