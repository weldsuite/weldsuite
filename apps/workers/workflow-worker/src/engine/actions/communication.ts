/**
 * Communication actions: send_email, send_notification, slack_message.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { ActionHandler } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';

export const handleSendEmail: ActionHandler = async (inputs, ctx) => {
  const to = inputs.to as string | string[] | undefined;
  if (!to || (typeof to === 'string' && !to.trim()) || (Array.isArray(to) && to.length === 0)) {
    throw new Error('No recipients defined for send_email action');
  }

  const toRecipients =
    typeof to === 'string'
      ? to.split(',').map((e) => e.trim()).filter(Boolean)
      : to.filter(Boolean);
  if (toRecipients.length === 0) throw new Error('No valid recipients after parsing');

  const accounts = await ctx.db
    .select()
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.status, 'active'), isNull(schema.mailAccounts.deletedAt)))
    .limit(5);

  const fromId = inputs.from as string | undefined;
  const account = fromId
    ? accounts.find((a: any) => a.email === fromId || a.id === fromId)
    : accounts.find((a: any) => a.isDefault) || accounts[0];

  if (!account) throw new Error('No email account configured');

  // POST /api/internal/send-email lives on app-api
  // (apps/workers/app-api/src/routes/internal/index.ts) — repointed there from the
  // legacy api-worker in phase W3 of the legacy-worker phase-out plan
  // (.claude/open-source-plan.md). This worker's INTERNAL_API_SECRET must
  // match app-api's for the bearer auth to pass.
  const appApiUrl = ctx.env.APP_API_URL
    ? String(ctx.env.APP_API_URL).replace(/\/+$/, '')
    : 'https://app-api.weldsuite.org';
  const internalSecret = ctx.env.INTERNAL_API_SECRET;
  if (!internalSecret) throw new Error('INTERNAL_API_SECRET not configured for email sending');

  const acct = account as { displayName?: string; email: string };
  const fromAddress = acct.displayName ? `${acct.displayName} <${acct.email}>` : acct.email;

  const response = await fetch(`${appApiUrl}/api/internal/send-email`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${internalSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress,
      to: toRecipients,
      subject: String(inputs.subject || ''),
      html: String(inputs.body || inputs.html || ''),
      text: String(inputs.body || '').replace(/<[^>]*>/g, ''),
      cc: inputs.cc as string[] | undefined,
      bcc: inputs.bcc as string[] | undefined,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Email send failed: ${response.status} - ${errorBody}`);
  }

  const result = (await response.json()) as { success: boolean; messageId: string };
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
