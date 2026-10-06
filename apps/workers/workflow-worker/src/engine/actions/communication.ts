/**
 * Communication actions: send_email, send_notification, slack_message.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { ActionHandler } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';
import { NonRetryableStepError } from '../errors';
import { escapeHtml } from '../resolve-inputs';
import { EMAIL_ADDRESS, postInternalApi } from './helpers';

/** `a@b.co` or `Display Name <a@b.co>`: whether the address part is valid. */
export function isValidRecipient(recipient: string): boolean {
  const angled = /<([^<>]*)>\s*$/.exec(recipient);
  return EMAIL_ADDRESS.test((angled ? angled[1] : recipient).trim());
}

/** Split a resolved recipient field (comma/semicolon list or array) into trimmed, non-empty entries. */
function splitRecipients(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [];
  return items.map((item) => String(item ?? '').trim()).filter(Boolean);
}

/**
 * Recipients of one field after variable resolution, each checked up front so a
 * bad address fails the step at once instead of coming back from the mail
 * service as an opaque 500 (and being retried).
 */
function validatedRecipients(value: unknown, field: 'To' | 'Cc' | 'Bcc', required: boolean): string[] {
  const recipients = splitRecipients(value);
  if (recipients.length === 0) {
    if (required) {
      throw new NonRetryableStepError(`No recipient address: "${field}" resolved to an empty value`);
    }
    return [];
  }
  const invalid = recipients.find((r) => !isValidRecipient(r));
  if (invalid !== undefined) {
    throw new NonRetryableStepError(`Recipient address "${invalid}" is not valid` + (field === 'To' ? '' : ` (${field})`));
  }
  return recipients;
}

export const handleSendEmail: ActionHandler = async (inputs, ctx) => {
  const toRecipients = validatedRecipients(inputs.to, 'To', true);
  const ccRecipients = validatedRecipients(inputs.cc, 'Cc', false);
  const bccRecipients = validatedRecipients(inputs.bcc, 'Bcc', false);

  const subject = String(inputs.subject ?? '').trim();
  if (!subject) throw new NonRetryableStepError('Email subject is required');

  const accounts = await ctx.db
    .select()
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.status, 'active'), isNull(schema.mailAccounts.deletedAt)))
    .limit(5);

  const fromId = inputs.from as string | undefined;
  const account = fromId
    ? accounts.find((a: any) => a.email === fromId || a.id === fromId)
    : accounts.find((a: any) => a.isDefault) || accounts[0];

  if (!account) throw new NonRetryableStepError('No email account configured');

  const acct = account as { displayName?: string; email: string };
  const fromAddress = acct.displayName ? `${acct.displayName} <${acct.email}>` : acct.email;

  // The editor's "Plain text" tab saves `isHtml: false`; keep its line breaks
  // in the HTML part instead of collapsing the whole message onto one line.
  const rawBody = String(inputs.body || inputs.html || '');
  const isPlainText = inputs.isHtml === false;
  const html = isPlainText ? escapeHtml(rawBody).replace(/\r?\n/g, '<br>') : rawBody;
  const text = isPlainText ? rawBody : rawBody.replace(/<[^>]*>/g, '');

  // POST /api/internal/send-email lives on app-api
  // (apps/workers/app-api/src/routes/internal/index.ts).
  const result = await postInternalApi<{ success: boolean; messageId: string }>(
    ctx.env,
    '/send-email',
    {
      from: fromAddress,
      to: toRecipients,
      subject,
      html,
      text,
      cc: ccRecipients.length > 0 ? ccRecipients : undefined,
      bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
    },
    'Email send',
    'APP_API_INTERNAL',
  );
  return { success: true, messageId: result.messageId, from: acct.email };
};

export const handleSendNotification: ActionHandler = async (inputs, ctx) => {
  const title = String(inputs.title || '');
  const body = String(inputs.body || inputs.message || '');
  if (!title) throw new Error('Notification title is required');

  let userIds: string[] = [];
  if (Array.isArray(inputs.userIds) && inputs.userIds.length > 0) {
    userIds = inputs.userIds.map((id) => String(id));
  } else if (inputs.userId) {
    userIds = [String(inputs.userId)];
  } else if (ctx.tenant.userId) {
    userIds = [ctx.tenant.userId];
  }
  if (userIds.length === 0) throw new Error('At least one recipient is required');

  const notificationIds: string[] = [];
  const now = new Date();

  // NOTE: the `notifications` tenant table has no workspaceId column (per-workspace DB).
  for (const userId of userIds) {
    const notificationId = generateId('notif');
    notificationIds.push(notificationId);
    await ctx.db.insert(schema.notifications).values({
      id: notificationId,
      userId,
      title,
      body: body || null,
      category: String(inputs.category || 'task'),
      notificationType: String(inputs.notificationType || inputs.type || 'custom'),
      entityType: inputs.entityType ? String(inputs.entityType) : null,
      entityId: inputs.entityId ? String(inputs.entityId) : null,
      actionUrl: inputs.actionUrl ? String(inputs.actionUrl) : null,
      icon: inputs.icon ? String(inputs.icon) : null,
      severity: String(inputs.severity || 'info'),
      data: (inputs.data as Record<string, unknown>) || null,
      isRead: false,
      deliveredInApp: true,
      deliveredEmail: false,
      deliveredPush: false,
      createdAt: now,
    });
  }

  return { sent: true, notificationIds, count: notificationIds.length };
};

export const handleSlackMessage: ActionHandler = async (inputs, ctx) => {
  const channel = String(inputs.channel || '');
  const text = String(inputs.text || '');
  if (!channel) throw new Error('Slack channel is required');
  if (!text) throw new Error('Slack message text is required');

  const integ = await resolveIntegration(ctx.db, {
    type: 'slack',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });
  const token = integrationBearerToken(integ);
  if (!token) throw new Error('Slack integration has no usable token');

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });

  const result = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  if (!result.ok) throw new Error(`Slack error: ${result.error || 'unknown'}`);
  return { sent: true, channel, ts: result.ts };
};
