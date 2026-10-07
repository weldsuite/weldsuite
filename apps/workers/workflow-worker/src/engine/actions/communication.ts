/**
 * Communication actions: send_email, send_notification, slack_message.
 */

import { eq, and, inArray, isNull } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { ActionHandler } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';
import { NonRetryableStepError } from '../errors';
import { escapeHtml } from '../resolve-inputs';
import { EMAIL_ADDRESS, postInternalApi } from './helpers';
import { asText } from '@weldsuite/text';

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

  const subject = asText(inputs.subject ?? '').trim();
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
  const rawBody = asText(inputs.body || inputs.html || '');
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

/** Recipient user ids from the step: `userIds` (array or comma list) or a single `userId`. */
function notificationRecipients(inputs: Record<string, unknown>): string[] {
  const raw = Array.isArray(inputs.userIds) && inputs.userIds.length > 0 ? inputs.userIds : inputs.userId;
  const ids = Array.isArray(raw) ? raw.map((id) => String(id ?? '')) : String(raw ?? '').split(',');
  // An unresolved {{variable}} arrives as an empty string: drop it.
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/**
 * send_notification — an in-app notification (bell + live toast) for workspace
 * members. Recipients that are not (or no longer) members are skipped; with
 * none given, the workflow's owner is notified. Delivered like run
 * notifications (run-notifications.ts): the row, then a live push.
 */
export const handleSendNotification: ActionHandler = async (inputs, ctx) => {
  const title = String(inputs.title || '').trim();
  const body = asText(inputs.body || inputs.message || '');
  if (!title) throw new NonRetryableStepError('Notification title is required');

  let requested = notificationRecipients(inputs);
  if (requested.length === 0) {
    const fallback = ctx.tenant.ownerUserId ?? (ctx.tenant.userId !== 'system' ? ctx.tenant.userId : undefined);
    requested = fallback ? [fallback] : [];
  }
  if (requested.length === 0) throw new NonRetryableStepError('Choose at least one member to notify');

  const { workspaceMembers } = schema;
  const memberRows = await ctx.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, requested), isNull(workspaceMembers.deletedAt)));
  const members = new Set(memberRows.map((row) => row.userId));
  const userIds = requested.filter((id) => members.has(id));
  if (userIds.length === 0) {
    throw new NonRetryableStepError('None of the recipients is a member of this workspace');
  }

  const publisher = ctx.env.REALTIME ? new RealtimePublisher(ctx.env.REALTIME) : null;
  const notificationIds: string[] = [];
  const now = new Date();
  const category = String(inputs.category || 'task');
  const notificationType = String(inputs.notificationType || inputs.type || 'custom');
  const severity = String(inputs.severity || 'info');
  const actionUrl = inputs.actionUrl ? String(inputs.actionUrl) : null;
  const entityType = inputs.entityType ? String(inputs.entityType) : null;
  const entityId = inputs.entityId ? String(inputs.entityId) : null;

  // NOTE: the `notifications` tenant table has no workspaceId column (per-workspace DB).
  for (const userId of userIds) {
    const notificationId = generateId('notif');
    notificationIds.push(notificationId);
    await ctx.db.insert(schema.notifications).values({
      id: notificationId,
      userId,
      title,
      body: body || null,
      category,
      notificationType,
      entityType,
      entityId,
      actionUrl,
      icon: inputs.icon ? String(inputs.icon) : 'workflow',
      severity,
      data: (inputs.data as Record<string, unknown>) || null,
      actorType: 'system',
      isRead: false,
      deliveredInApp: true,
      deliveredEmail: false,
      deliveredPush: false,
      createdAt: now,
    });
    try {
      await publisher?.notify(ctx.tenant.workspaceId, userId, {
        id: notificationId,
        title,
        body,
        category,
        notificationType,
        actionUrl,
        entityType,
        entityId,
        createdAt: now.toISOString(),
        isRead: false,
        severity,
        actorType: 'system',
        actorId: null,
      });
    } catch (err) {
      // The row is saved; the bell shows it on the next load.
      console.warn('[send_notification] live publish failed:', err);
    }
  }

  return {
    sent: true,
    notificationIds,
    notifiedUserIds: userIds,
    count: notificationIds.length,
    skipped: requested.length - userIds.length,
  };
};

/**
 * Legacy pre-catalog Slack action. Kept registered (`slack_message` in
 * actions/index.ts) for compatibility only — any workflow saved before the
 * `@weldsuite/workflow-integrations` catalog existed that still has a
 * `slack_message` step keeps running unchanged. It is not in
 * `WELDCONNECT_ACTION_TYPES` (services/weldconnect-mvp.ts), so the editor
 * never offers it and the activation gate refuses it on a fresh workflow —
 * `slack.post_message` (providers/slack.ts) is the one real editor step now,
 * with channel validation, thread replies, richer errors and the owner
 * membership check. Do not add features here; port them to providers/slack.ts
 * instead and let this one keep doing exactly what it always did.
 */
export const handleSlackMessage: ActionHandler = async (inputs, ctx) => {
  const channel = asText(inputs.channel || '');
  const text = asText(inputs.text || '');
  if (!channel) throw new Error('Slack channel is required');
  if (!text) throw new Error('Slack message text is required');

  const integ = await resolveIntegration(ctx.db, {
    type: 'slack',
    integrationId: inputs.integrationId ? asText(inputs.integrationId) : undefined,
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
