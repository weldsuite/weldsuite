/**
 * Slack Webhook Routes
 *
 * Handles inbound Slack messages via the Slack Events API.
 * Converts Slack messages → @weldsuite/realtime publish.
 * The inbound webhook handler (in helpdesk-workflow-worker) persists messages,
 * triggers workflows, sends push notifications, etc.
 *
 * Mounted BEFORE widgetAuthMiddleware — uses Slack signature verification.
 */

import { Hono } from 'hono';
import { eq, and, ne, isNull, sql } from 'drizzle-orm';
import type { Env } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { generateId } from '../lib/id';
import { findOrCreatePersonByEmail } from '@weldsuite/db';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { notifyAgentsOfNewConversation } from '../services/push-notifications';
import { publishEntityEvent } from '../lib/entity-events';
import { executeSlackWorkflows, resumeSlackWorkflow } from '../services/slack-workflow';

type SlackVariables = Record<string, unknown>;

export const slackRoutes = new Hono<{ Bindings: Env; Variables: SlackVariables }>();

// ============================================================================
// Types
// ============================================================================

interface SlackEventPayload {
  token?: string;
  type: string;
  challenge?: string; // URL verification
  event?: SlackEvent;
  team_id?: string;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}

// ============================================================================
// Signature Verification
// ============================================================================

async function verifySlackSignature(
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  signingSecret: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString));
  const computed = 'v0=' + Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return computed === signature;
}

// ============================================================================
// POST /events — Slack Events API receiver
// ============================================================================

slackRoutes.post('/events', async (c) => {
  const rawBody = await c.req.text();

  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Handle URL verification challenge (Slack sends this when configuring the Events URL)
  if (payload.type === 'url_verification' && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  // Verify Slack signature
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const valid = await verifySlackSignature(
      rawBody,
      c.req.header('x-slack-signature'),
      c.req.header('x-slack-request-timestamp'),
      signingSecret,
    );
    if (!valid) {
      console.warn('[Slack] Invalid signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  // Only process event_callback with message events
  if (payload.type !== 'event_callback' || !payload.event) {
    return c.json({ ok: true });
  }

  const event = payload.event;

  // Only process regular messages (not bot messages, edits, deletes, etc.)
  if (event.type !== 'message' || event.subtype || event.bot_id || !event.text || !event.user) {
    return c.json({ ok: true });
  }

  const teamId = payload.team_id;
  if (!teamId) {
    return c.json({ ok: true, skipped: 'no team_id' });
  }

  try {
    // Resolve workspace from KV (slack_team:{teamId} → { clerkOrgId, ... })
    const kvData = await c.env.WORKSPACE_CACHE.get(`slack_team:${teamId}`, 'json') as {
      clerkOrgId: string;
      internalWorkspaceId: string;
    } | null;

    if (!kvData) {
      console.warn(`[Slack] No workspace mapping for team ${teamId}`);
      return c.json({ ok: true, skipped: 'team not configured' });
    }

    const { clerkOrgId } = kvData;
    const db = await getTenantDbForWorkspace(c.env, clerkOrgId);

    // Look up Slack integration config
    const [integration] = await db
      .select()
      .from(schema.helpdeskChannelIntegrations)
      .where(
        and(
          eq(schema.helpdeskChannelIntegrations.provider, 'slack'),
          isNull(schema.helpdeskChannelIntegrations.deletedAt),
        ),
      )
      .limit(1);

    if (!integration || integration.status !== 'connected') {
      return c.json({ ok: true, skipped: 'integration not active' });
    }

    // Check if this channel is monitored
    const config = (integration.config || {}) as Record<string, unknown>;
    const supportChannels = (config.supportChannels || []) as Array<{ channelId: string; enabled: boolean }>;
    if (supportChannels.length > 0) {
      const channelConfig = supportChannels.find((ch) => ch.channelId === event.channel);
      if (!channelConfig || !channelConfig.enabled) {
        return c.json({ ok: true, skipped: 'channel not monitored' });
      }
    }

    // Find or create conversation (thread-aware: use thread_ts if present)
    const slackThreadId = event.thread_ts || event.ts;
    const slackChannelId = event.channel!;
    let customerEmail = `slack:${event.user}@slack`;
    let personId: string | null = null;

    // Resolve Slack user display name + email via Web API if bot token is available
    let customerName = event.user!;
    const botToken = config.botToken as string | undefined;
    if (botToken) {
      try {
        const userInfo = await fetch(`https://slack.com/api/users.info?user=${event.user}`, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const userData = await userInfo.json() as {
          ok: boolean;
          user?: {
            real_name?: string;
            profile?: { display_name?: string; email?: string };
          };
        };
        if (userData.ok && userData.user) {
          customerName = userData.user.profile?.display_name || userData.user.real_name || event.user!;

          // Auto-link person via email if available (requires users:read.email scope)
          const slackEmail = userData.user.profile?.email;
          if (slackEmail) {
            customerEmail = slackEmail;

            // Resolve email → person (creates a guest row if missing). Falls
            // out of the contacts-table dependency for slack identity matching.
            const resolved = await findOrCreatePersonByEmail(
              db,
              { email: slackEmail, displayName: customerName },
              generateId,
            );
            if (resolved) {
              personId = resolved.personId;
              if (resolved.displayName) customerName = resolved.displayName;
            }

            // Upsert external identity link.
            try {
              await db.insert(schema.contactExternalIdentities).values({
                id: generateId('ceid'),
                personId,
                provider: 'slack',
                externalId: event.user!,
                externalName: customerName,
                externalEmail: slackEmail,
                metadata: { slackTeamId: teamId },
                createdAt: new Date(),
                updatedAt: new Date(),
              }).onConflictDoUpdate({
                target: [schema.contactExternalIdentities.provider, schema.contactExternalIdentities.externalId],
                set: {
                  personId,
                  externalName: customerName,
                  externalEmail: slackEmail,
                  updatedAt: new Date(),
                },
              });
            } catch {
              // Non-fatal — identity linking is best-effort
            }
          }
        }
      } catch {
        // Non-fatal — fall back to user ID
      }
    }

    // Thread-aware lookup
    const [existing] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(
        and(
          eq(schema.helpdeskConversations.channel, 'slack'),
          sql`${schema.helpdeskConversations.metadata}->>'slackThreadTs' = ${slackThreadId}`,
          ne(schema.helpdeskConversations.status, 'closed'),
          isNull(schema.helpdeskConversations.deletedAt),
        ),
      )
      .limit(1);

    let conversationId: string;
    let isNewConversation = false;

    if (existing) {
      conversationId = existing.id;
      customerName = existing.customerName || customerName;
    } else {
      conversationId = generateId('conv');
      isNewConversation = true;
      const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;

      await db.insert(schema.helpdeskConversations).values({
        id: conversationId,
        conversationNumber,
        subject: `Slack: ${customerName}`,
        status: 'active',
        channel: 'slack',
        customerEmail,
        customerName,
        personId,
        messageCount: 0,
        unreadCount: 0,
        isRead: false,
        isStarred: false,
        isArchived: false,
        hasAttachments: false,
        hasActiveWorkflow: false,
        tags: [],
        metadata: {
          slackTeamId: teamId,
          slackChannelId,
          slackThreadTs: slackThreadId,
          slackUserId: event.user,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Auto-reply in thread (Intercom-style) — establishes the thread
      if (botToken) {
        try {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slackChannelId,
              thread_ts: event.ts, // Reply to the original message to create a thread
              text: 'Thanks for reaching out! A team member will be with you shortly.',
            }),
          });
        } catch {
          // Non-fatal — thread creation is best-effort
        }
      }
    }

    // Persist message to helpdeskConversationMessages
    const msgId = generateId('msg');
    const now = new Date();

    await db.insert(schema.helpdeskConversationMessages).values({
      id: msgId,
      conversationId,
      authorId: `slack_${event.user}`,
      authorName: customerName,
      authorType: 'customer',
      content: event.text!,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      metadata: {
        slackMessageTs: event.ts,
        slackChannelId,
        slackThreadTs: slackThreadId,
        channel: 'slack',
      },
      createdAt: now,
      updatedAt: now,
    });

    // Update conversation counters
    await db
      .update(schema.helpdeskConversations)
      .set({
        lastMessage: event.text!.substring(0, 500),
        preview: event.text!.substring(0, 200),
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        messageCount: sql`${schema.helpdeskConversations.messageCount} + 1`,
        unreadCount: sql`${schema.helpdeskConversations.unreadCount} + 1`,
        isRead: false,
        updatedAt: now,
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    // Publish to realtime (for agent inbox live updates)
    try {
      if (c.env.REALTIME) {
        const realtime = new RealtimePublisher(c.env.REALTIME);
        await realtime.conversationMessage(conversationId, {
          id: msgId,
          content: event.text!,
          senderId: `slack_${event.user}`,
          senderName: customerName,
          senderType: 'customer',
        });

        if (isNewConversation) {
          await realtime.helpdeskEvent(clerkOrgId, 'conversation_new', {
            conversationId,
            subject: `Slack: ${customerName}`,
            customerName,
            customerEmail,
            preview: event.text!.substring(0, 200),
            channel: 'slack',
            createdAt: now.toISOString(),
          });
        } else {
          await realtime.helpdeskEvent(clerkOrgId, 'message_new', {
            conversationId,
            preview: event.text!.substring(0, 200),
            senderName: customerName,
          });
        }
      }
    } catch (realtimeErr) {
      console.error('[Slack] Failed to publish realtime:', realtimeErr);
    }

    console.log(`[Slack] Message from ${event.user} persisted → conversation ${conversationId} (new: ${isNewConversation})`);

    // Fire-and-forget: execute workflows inline + push notifications + entity events
    c.executionCtx.waitUntil(
      (async () => {
        // Execute workflows inline (no dependency on workflow-worker)
        if (botToken) {
          try {
            await executeSlackWorkflows({
              db,
              conversationId,
              workspaceId: clerkOrgId,
              eventType: isNewConversation ? 'conversation_created' : 'message_received',
              botToken,
              slackChannelId,
              slackThreadTs: slackThreadId,
              triggerData: {
                conversationId,
                workspaceId: clerkOrgId,
                channel: 'slack',
                customerName,
                customerEmail,
                content: event.text,
                messageId: msgId,
              },
            });
          } catch (wfErr) {
            console.error('[Slack] Workflow execution failed:', wfErr);
          }
        }

        // Push notifications
        if (isNewConversation) {
          try {
            await notifyAgentsOfNewConversation(db, {
              id: conversationId,
              subject: `Slack: ${customerName}`,
              customerName,
              preview: event.text!.substring(0, 200),
            }, c.env.FIREBASE_SERVICE_ACCOUNT);
          } catch (pushErr) {
            console.error('[Slack] Push notification error:', pushErr);
          }
        }

        // Entity event
        publishEntityEvent({
          c: c as any,
          entityType: 'helpdesk_conversation_message',
          entityId: msgId,
          action: 'created',
          data: {
            id: msgId,
            conversationId,
            authorType: 'customer',
            authorName: customerName,
            content: event.text,
            channel: 'slack',
          },
        });
      })(),
    );

    return c.json({ ok: true });
  } catch (err) {
    console.error('[Slack] Message processing error:', err);
    return c.json({ ok: true }); // Always return 200 to Slack to prevent retries
  }
});

// ============================================================================
// POST /interactions — Slack Interactive Components (button clicks, modals)
// ============================================================================

slackRoutes.post('/interactions', async (c) => {
  // Read raw body first for signature verification, then parse
  const rawBody = await c.req.text();

  // Verify Slack signature against the raw body
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const valid = await verifySlackSignature(
      rawBody,
      c.req.header('x-slack-signature'),
      c.req.header('x-slack-request-timestamp'),
      signingSecret,
    );
    if (!valid) return c.json({ error: 'Invalid signature' }, 401);
  }

  // Parse the URL-encoded body to get the payload JSON
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload');

  if (!payloadStr) return c.json({ error: 'Missing payload' }, 400);

  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: 'Invalid payload JSON' }, 400);
  }

  // ── Handle modal form submissions ──
  if (payload.type === 'view_submission') {
    const privateMetadata = JSON.parse(payload.view?.private_metadata || '{}');
    const { conversationId, stepId, teamId: metaTeamId } = privateMetadata;

    if (!conversationId || !metaTeamId) return c.json({ response_action: 'clear' });

    try {
      const kvData = await c.env.WORKSPACE_CACHE.get(`slack_team:${metaTeamId}`, 'json') as { clerkOrgId: string } | null;
      if (!kvData) return c.json({ response_action: 'clear' });

      const db = await getTenantDbForWorkspace(c.env, kvData.clerkOrgId);

      // Extract field values from modal
      const submittedData: Record<string, string> = {};
      const stateValues = payload.view?.state?.values || {};
      for (const blockId of Object.keys(stateValues)) {
        for (const actionId of Object.keys(stateValues[blockId])) {
          const val = stateValues[blockId][actionId]?.value;
          if (val) submittedData[actionId] = val;
        }
      }

      // Persist as customer message
      const summary = Object.entries(submittedData).map(([k, v]) => `*${k}*: ${v}`).join('\n');
      const msgId = generateId('msg');
      await db.insert(schema.helpdeskConversationMessages).values({
        id: msgId,
        conversationId,
        content: summary,
        authorType: 'customer',
        authorId: `slack_${payload.user?.id || 'unknown'}`,
        authorName: payload.user?.name || payload.user?.username || 'Customer',
        type: 'message',
        isPublic: true,
        isInternal: false,
        status: 'sent',
        isRead: false,
        metadata: { formSubmission: true, submittedData, workflowStepId: stepId, channel: 'slack' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Mark execution as completed
      const [execution] = await db
        .select({ id: schema.helpdeskWorkflowExecutions.id })
        .from(schema.helpdeskWorkflowExecutions)
        .where(
          and(
            eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
            eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
          ),
        )
        .limit(1);

      console.log(`[Slack] Form submitted: ${conversationId}/${stepId} → ${JSON.stringify(submittedData)}`);

      // Resume workflow with remaining steps
      if (execution) {
        const [conv] = await db.select({ metadata: schema.helpdeskConversations.metadata })
          .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);
        const convMeta = (conv?.metadata || {}) as Record<string, unknown>;

        const [integ] = await db.select({ config: schema.helpdeskChannelIntegrations.config })
          .from(schema.helpdeskChannelIntegrations)
          .where(and(eq(schema.helpdeskChannelIntegrations.provider, 'slack'), isNull(schema.helpdeskChannelIntegrations.deletedAt)))
          .limit(1);
        const bt = (integ?.config as any)?.botToken;

        if (bt && convMeta.slackChannelId && convMeta.slackThreadTs) {
          c.executionCtx.waitUntil(
            resumeSlackWorkflow({
              db,
              conversationId,
              workspaceId: kvData.clerkOrgId,
              executionId: execution.id,
              botToken: bt,
              slackChannelId: convMeta.slackChannelId as string,
              slackThreadTs: convMeta.slackThreadTs as string,
            }),
          );
        }
      }
    } catch (err) {
      console.error('[Slack] Form submission error:', err);
    }

    return c.json({ response_action: 'clear' });
  }

  // ── Handle button clicks (block_actions) ──
  if (payload.type !== 'block_actions' || !payload.actions?.length) {
    return c.json({ ok: true });
  }

  const action = payload.actions[0];
  const actionId = action.action_id;

  if (!actionId.startsWith('wf_')) return c.json({ ok: true });

  const parts = actionId.split(':');
  if (parts.length < 3) return c.json({ ok: true });

  const teamId = payload.team?.id;
  if (!teamId) return c.json({ ok: true });

  // ── Handle wf_form button → open modal ──
  if (parts[0] === 'wf_form') {
    const [, conversationId, stepId] = parts;
    const triggerId = payload.trigger_id;

    if (!triggerId) return c.json({ ok: true });

    try {
      const kvData = await c.env.WORKSPACE_CACHE.get(`slack_team:${teamId}`, 'json') as { clerkOrgId: string } | null;
      if (!kvData) return c.json({ ok: true });

      const db = await getTenantDbForWorkspace(c.env, kvData.clerkOrgId);

      // Get field definitions from the message metadata
      const [msg] = await db
        .select({ metadata: schema.helpdeskConversationMessages.metadata })
        .from(schema.helpdeskConversationMessages)
        .where(
          and(
            eq(schema.helpdeskConversationMessages.conversationId, conversationId),
            sql`${schema.helpdeskConversationMessages.metadata}->>'workflowStepId' = ${stepId}`,
          ),
        )
        .limit(1);

      const fields = ((msg?.metadata as any)?.fields || []) as Array<{ id?: string; label?: string; type?: string; required?: boolean }>;

      // Build modal view
      const blocks = (fields.length > 0 ? fields : [{ id: 'response', label: 'Your response' }]).map((field: any) => {
        const fieldId = typeof field === 'string' ? field : (field.id || field.label || 'field');
        const fieldLabel = typeof field === 'string' ? field.charAt(0).toUpperCase() + field.slice(1) : (field.label || field.id || 'Field');
        const isLong = typeof field !== 'string' && field.type === 'textarea';

        return {
          type: 'input',
          block_id: `block_${fieldId}`,
          element: {
            type: 'plain_text_input',
            action_id: fieldId,
            multiline: isLong,
          },
          label: { type: 'plain_text', text: fieldLabel.slice(0, 48) },
          optional: typeof field !== 'string' ? !(field.required ?? false) : false,
        };
      });

      // Open modal via views.open
      const integration = await db
        .select({ config: schema.helpdeskChannelIntegrations.config })
        .from(schema.helpdeskChannelIntegrations)
        .where(and(eq(schema.helpdeskChannelIntegrations.provider, 'slack'), isNull(schema.helpdeskChannelIntegrations.deletedAt)))
        .limit(1);

      const botToken = (integration[0]?.config as any)?.botToken;
      if (!botToken) return c.json({ ok: true });

      await fetch('https://slack.com/api/views.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'Fill in details' },
            submit: { type: 'plain_text', text: 'Submit' },
            close: { type: 'plain_text', text: 'Cancel' },
            private_metadata: JSON.stringify({ conversationId, stepId, teamId }),
            blocks,
          },
        }),
      });

      console.log(`[Slack] Opened form modal for ${conversationId}/${stepId}`);
    } catch (err) {
      console.error('[Slack] Failed to open form modal:', err);
    }

    return c.json({ ok: true });
  }

  // ── Handle wf_choice and wf_csat ──
  if (parts.length < 4) return c.json({ ok: true });

  const [actionType, conversationId, stepId, value] = parts;

  try {
    const kvData = await c.env.WORKSPACE_CACHE.get(`slack_team:${teamId}`, 'json') as { clerkOrgId: string } | null;
    if (!kvData) return c.json({ ok: true });

    const db = await getTenantDbForWorkspace(c.env, kvData.clerkOrgId);

    const [execution] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    if (!execution) {
      console.warn(`[Slack] No waiting execution for conversation ${conversationId}`);
      return c.json({ ok: true });
    }

    // Mark execution as completed with response
    const responseData: Record<string, unknown> = { stepId };
    if (actionType === 'wf_choice') {
      responseData.selectedValue = value;
      responseData.selectedLabel = value;
    } else if (actionType === 'wf_csat') {
      responseData.rating = parseInt(value, 10);
    }

    console.log(`[Slack] Interaction: ${actionType} → ${conversationId}/${stepId}/${value}`);

    // Resume workflow with remaining steps
    const [conv] = await db.select({ metadata: schema.helpdeskConversations.metadata })
      .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);
    const convMeta = (conv?.metadata || {}) as Record<string, unknown>;

    const [integ] = await db.select({ config: schema.helpdeskChannelIntegrations.config })
      .from(schema.helpdeskChannelIntegrations)
      .where(and(eq(schema.helpdeskChannelIntegrations.provider, 'slack'), isNull(schema.helpdeskChannelIntegrations.deletedAt)))
      .limit(1);
    const bt = (integ?.config as any)?.botToken;

    if (bt && convMeta.slackChannelId && convMeta.slackThreadTs) {
      c.executionCtx.waitUntil(
        resumeSlackWorkflow({
          db,
          conversationId,
          workspaceId: kvData.clerkOrgId,
          executionId: execution.id,
          botToken: bt,
          slackChannelId: convMeta.slackChannelId as string,
          slackThreadTs: convMeta.slackThreadTs as string,
        }),
      );
    }

    const confirmText = actionType === 'wf_csat'
      ? `Thank you for your feedback! (Rating: ${value}/5)`
      : `Selected: *${value}*`;

    return c.json({
      replace_original: true,
      text: confirmText,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${confirmText} :white_check_mark:` } }],
    });
  } catch (err) {
    console.error('[Slack] Interaction error:', err);
    return c.json({ ok: true });
  }
});
