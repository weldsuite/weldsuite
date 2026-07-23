import 'server-only';

import { sendEmail } from '@weldsuite/transactional-email';

const FROM_ADDRESS = 'WeldSuite <noreply@mail.weldsuite.org>';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC';
  } catch {
    return iso;
  }
}

function shell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;">
      <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:#a1a1aa;text-align:center;margin-top:16px;">WeldSuite</p>
  </div>
</body></html>`;
}

/**
 * Best-effort transactional emails for admin-scheduled workspace deletion.
 * Never throw — a mail failure must not block the scheduling/cancel action. If
 * `RESEND_API_KEY` is unset (e.g. local dev), these no-op with a warning.
 */
async function send(to: string[], subject: string, html: string): Promise<void> {
  if (to.length === 0) return;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[admin/workspace-deletion-email] RESEND_API_KEY not set — skipping email');
    return;
  }
  try {
    await sendEmail(apiKey, { from: FROM_ADDRESS, to, subject, html });
  } catch (err) {
    console.error('[admin/workspace-deletion-email] Failed to send email:', err);
  }
}

export async function sendDeletionScheduledEmail(
  to: string[],
  params: { workspaceName: string; deletionAtIso: string; reason?: string | null },
): Promise<void> {
  const when = formatDate(params.deletionAtIso);
  const reasonHtml = params.reason
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;"><strong>Reason:</strong> ${escapeHtml(params.reason)}</p>`
    : '';
  const html = shell(
    'Your workspace is scheduled for deletion',
    `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">
      The workspace <strong>${escapeHtml(params.workspaceName)}</strong> has been suspended and is scheduled to be permanently deleted on <strong>${when}</strong>.
    </p>
    <p style="font-size:14px;line-height:1.5;margin:0 0 12px;">
      Access is disabled while it is suspended. If you believe this is a mistake, please contact WeldSuite support before the deletion date — after that, the workspace and all its data will be permanently removed.
    </p>
    ${reasonHtml}`,
  );
  await send(to, `Your WeldSuite workspace "${params.workspaceName}" is scheduled for deletion`, html);
}

export async function sendDeletionCancelledEmail(
  to: string[],
  params: { workspaceName: string },
): Promise<void> {
  const html = shell(
    'Workspace deletion cancelled',
    `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">
      Good news — the scheduled deletion of your workspace <strong>${escapeHtml(params.workspaceName)}</strong> has been cancelled. The workspace has been restored and is active again.
    </p>`,
  );
  await send(to, `Your WeldSuite workspace "${params.workspaceName}" is active again`, html);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
