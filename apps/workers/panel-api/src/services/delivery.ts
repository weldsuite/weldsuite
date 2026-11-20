/**
 * Delivery of alert and scheduled-report messages on the channels an alert or
 * subscription names: email (`@weldsuite/emails`, `panel.alert` /
 * `panel.report-digest`), in-app (`@weldsuite/notifications`, the email channel
 * excluded since email has its own recipient list here), a Slack incoming
 * webhook (Block Kit), and a WeldChat channel (a system message from
 * "WeldPanel", `@weldsuite/chat-domain/post-system-message`).
 *
 * Every channel is tried on its own: one that fails never stops the others,
 * and its error is reported in the result (and stored by the caller as the
 * object's `lastError`). Messages are written per recipient locale (en, nl),
 * shared channels (Slack, WeldChat) in the workspace's language.
 *
 * The Slack webhook URL is opened here, used once and never logged; a Slack
 * error reports only its status and Slack's short answer.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import { postSystemChatMessage } from '@weldsuite/chat-domain/post-system-message';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import {
  emailStrings,
  panelAlertText,
  panelDigestText,
  resolveEmailLocale,
  sendSystemEmail,
  workspaceAppUrl,
  type EmailLocale,
  type EmailTransport,
  type PanelAlertEmailProps,
  type PanelDigestBlock,
  type PanelReportDigestEmailProps,
} from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { PanelDeliveryChannels } from '@weldsuite/db/schema';
import type {
  PanelDeliveryChannel,
  PanelDeliveryChannelsDto,
  PanelDeliveryResult,
  ParsedPanelDeliveryChannels,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { Env } from '../types';
import { openSecret, sealSecret } from './secrets';

const { chatChannels, userPreferences, workspaceMembers, workspaceSettings } = schema;

/** WeldChat author of WeldPanel's posts (a system message, never a teammate). */
export const WELDPANEL_CHAT_AUTHOR = 'app:weldpanel';
export const WELDPANEL_CHAT_AUTHOR_NAME = 'WeldPanel';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A digest block before its link is made absolute. */
export type DigestBlockDraft = Omit<PanelDigestBlock, 'url'> & { path?: string | null };

/** A scheduled report in one locale (labels WeldPanel computes are translated). */
export type DigestDraft = Omit<PanelReportDigestEmailProps, 'url' | 'blocks'> & { blocks: DigestBlockDraft[] };

export type PanelMessage =
  | {
      kind: 'alert';
      /** The alert's id. */
      entityId: string;
      /** Platform path of the alert, without the workspace prefix. */
      path: string;
      alert: Omit<PanelAlertEmailProps, 'url'>;
    }
  | {
      kind: 'report';
      /** The subscription's id. */
      entityId: string;
      path: string;
      /** The digest in a locale: its numbers are computed once, its labels translated per reader. */
      digest: (locale: EmailLocale) => DigestDraft;
    };

/** Where a message goes: the object's channels, its sealed Slack webhook and its owner. */
export interface DeliveryTarget {
  channels: PanelDeliveryChannels;
  slackWebhookCiphertext: string | null;
  ownerUserId: string;
}

export interface DeliveryContext {
  env: Env;
  /** The workspace's tenant database. */
  db: Database;
  /** `workspaces.id`. */
  workspaceId: string;
  /** The Clerk org id: in-app notifications, WeldChat and app links go there. */
  clerkOrgId: string;
  /** Who the message is sent for (the object's owner, or the member who pressed "test"). */
  actorUserId: string;
  /** Tests: a memory transport, a fake Slack, stub senders. */
  transport?: EmailTransport | null;
  fetch?: typeof fetch;
  senders?: Partial<DeliverySenders>;
}

export interface Recipient {
  userId: string;
  email: string | null;
  name: string | null;
  locale: EmailLocale;
}

interface SendOutcome {
  sent: number;
  failed: number;
  error: string | null;
}

export interface DeliverySenders {
  email(ctx: DeliveryContext, recipients: Recipient[], message: PanelMessage): Promise<SendOutcome>;
  inApp(ctx: DeliveryContext, recipients: Recipient[], message: PanelMessage): Promise<SendOutcome>;
  slack(ctx: DeliveryContext, webhookUrl: string, message: PanelMessage, locale: EmailLocale): Promise<void>;
  weldchat(ctx: DeliveryContext, channelId: string, message: PanelMessage, locale: EmailLocale): Promise<void>;
}

// ---------------------------------------------------------------------------
// Links and text
// ---------------------------------------------------------------------------

export function appBase(env: Pick<Env, 'PLATFORM_URL'>): string {
  return (env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/$/, '');
}

export function appUrl(ctx: Pick<DeliveryContext, 'env' | 'clerkOrgId'>, path: string): string {
  return workspaceAppUrl(appBase(ctx.env), ctx.clerkOrgId, path);
}

function alertProps(ctx: DeliveryContext, message: Extract<PanelMessage, { kind: 'alert' }>): PanelAlertEmailProps {
  return { ...message.alert, url: appUrl(ctx, message.path) };
}

function digestProps(ctx: DeliveryContext, message: Extract<PanelMessage, { kind: 'report' }>, locale: EmailLocale): PanelReportDigestEmailProps {
  const draft = message.digest(locale);
  return {
    ...draft,
    blocks: draft.blocks.map(({ path, ...block }) => ({ ...block, url: path ? appUrl(ctx, path) : null })),
    url: appUrl(ctx, message.path),
  };
}

/** Title, body and the lines below them, in `locale`. */
export function messageText(ctx: DeliveryContext, message: PanelMessage, locale: EmailLocale): { title: string; body: string; lines: string[]; url: string } {
  if (message.kind === 'alert') {
    const props = alertProps(ctx, message);
    return { ...panelAlertText(props, locale), lines: [], url: props.url };
  }
  const props = digestProps(ctx, message, locale);
  return { ...panelDigestText(props, locale), url: props.url };
}

function openLabel(message: PanelMessage, locale: EmailLocale): string {
  const t = emailStrings(locale).panel;
  return message.kind === 'alert' ? t.alert.button : t.reportDigest.button;
}

/** Slack mrkdwn: `&`, `<` and `>` are control characters. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Block Kit payload for a Slack incoming webhook. */
export function slackPayload(ctx: DeliveryContext, message: PanelMessage, locale: EmailLocale): Record<string, unknown> {
  const text = messageText(ctx, message, locale);
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: text.title.slice(0, 150), emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: slackEscape(text.body).slice(0, 3000) } },
  ];
  // Sections hold 3,000 characters each; Slack takes 50 blocks.
  let chunk = '';
  for (const line of text.lines) {
    const next = `${chunk}${chunk ? '\n' : ''}${slackEscape(line)}`;
    if (next.length > 2900) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = slackEscape(line).slice(0, 2900);
    } else chunk = next;
  }
  if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${text.url}|${slackEscape(openLabel(message, locale))}>` }] });
  return { text: text.title, blocks: blocks.slice(0, 50) };
}

/** A WeldChat post: never a mention (`<@…>`), whatever names the alert or report carry. */
export function weldchatContent(ctx: DeliveryContext, message: PanelMessage, locale: EmailLocale): string {
  const text = messageText(ctx, message, locale);
  const safe = (s: string) => s.replace(/<@/g, '<​@');
  const parts = [`**${safe(text.title)}**`, safe(text.body)];
  if (text.lines.length > 0) parts.push(text.lines.map(safe).join('\n'));
  parts.push(`[${openLabel(message, locale)}](${text.url})`);
  return parts.join('\n\n').slice(0, 8000);
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** The workspace's language, for Slack and WeldChat. */
export async function workspaceLocale(db: Database): Promise<EmailLocale> {
  const [row] = await db.select({ language: workspaceSettings.language }).from(workspaceSettings).where(isNull(workspaceSettings.deletedAt)).limit(1);
  return resolveEmailLocale(row?.language);
}

/** Active members among `userIds`, with their address and locale. Unknown or removed ids drop out. */
export async function memberRecipients(db: Database, userIds: readonly string[]): Promise<Recipient[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const [members, prefs, workspaceLanguage] = await Promise.all([
    db
      .select({ userId: workspaceMembers.userId, email: workspaceMembers.email, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(and(inArray(workspaceMembers.userId, ids), isNull(workspaceMembers.deletedAt), eq(workspaceMembers.status, 'ACTIVE'))),
    db.select({ userId: userPreferences.userId, language: userPreferences.language }).from(userPreferences).where(inArray(userPreferences.userId, ids)),
    db.select({ language: workspaceSettings.language }).from(workspaceSettings).where(isNull(workspaceSettings.deletedAt)).limit(1),
  ]);
  const languages = new Map(prefs.map((p) => [p.userId, p.language]));
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const m of members) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    out.push({ userId: m.userId, email: m.email, name: m.name, locale: resolveEmailLocale(languages.get(m.userId), workspaceLanguage[0]?.language) });
  }
  return out;
}

/** Ids among `userIds` that are not active members of the workspace. */
export async function unknownMembers(db: Database, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const known = new Set((await memberRecipients(db, userIds)).map((r) => r.userId));
  return [...new Set(userIds)].filter((id) => !known.has(id));
}

/** A WeldChat channel that exists and is not archived. */
export async function chatChannelExists(db: Database, channelId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt), eq(chatChannels.isArchived, false)))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/** A fired alert warns, a resolved one is good news; anything else informs. */
function severityOf(message: PanelMessage): 'warning' | 'success' | 'info' {
  if (message.kind !== 'alert') return 'info';
  if (message.alert.event === 'fired') return 'warning';
  return message.alert.event === 'resolved' ? 'success' : 'info';
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

const defaultSenders: DeliverySenders = {
  async email(ctx, recipients, message) {
    const transport = ctx.transport === undefined ? workerTransport(ctx.env) : ctx.transport;
    if (!transport) return { sent: 0, failed: recipients.length, error: 'Email is not configured here' };
    let sent = 0;
    let failed = 0;
    let error: string | null = null;
    for (const r of recipients) {
      if (!r.email) {
        failed += 1;
        continue;
      }
      try {
        if (message.kind === 'alert') {
          await sendSystemEmail(transport, { template: 'panel.alert', props: alertProps(ctx, message), to: r.email, locale: r.locale, brand: { kind: 'weldsuite', module: 'WeldPanel' } });
        } else {
          await sendSystemEmail(transport, {
            template: 'panel.report-digest',
            props: digestProps(ctx, message, r.locale),
            to: r.email,
            locale: r.locale,
            brand: { kind: 'weldsuite', module: 'WeldPanel' },
          });
        }
        sent += 1;
      } catch (err) {
        failed += 1;
        error = errorText(err);
      }
    }
    return { sent, failed, error: failed > 0 ? (error ?? 'Some members have no email address') : null };
  },

  async inApp(ctx, recipients, message) {
    let sent = 0;
    let failed = 0;
    let error: string | null = null;
    for (const r of recipients) {
      const text = messageText(ctx, message, r.locale);
      try {
        await createAndDeliverNotification({
          db: ctx.db,
          env: ctx.env,
          workspaceId: ctx.clerkOrgId,
          clerkOrgId: ctx.clerkOrgId,
          userId: r.userId,
          title: text.title.slice(0, 255),
          body: text.body.slice(0, 1000),
          category: 'weldpanel',
          notificationType: message.kind === 'alert' ? 'panel_alert' : 'panel_report',
          entityType: message.kind === 'alert' ? 'panel_alert' : 'panel_subscription',
          entityId: message.entityId,
          actionUrl: message.path,
          severity: severityOf(message),
          actorType: 'system',
          actorId: null,
          // This channel list has its own email recipients; the notification must not mail them again.
          excludeChannels: ['email'],
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        error = errorText(err);
      }
    }
    return { sent, failed, error };
  },

  async slack(ctx, webhookUrl, message, locale) {
    const doFetch = ctx.fetch ?? fetch;
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload(ctx, message, locale)),
    });
    if (!res.ok) {
      // Slack answers a short code (`invalid_token`, `channel_not_found`, `no_service`); never echo the URL.
      const answer = (await res.text().catch(() => '')).replace(/[^\w .-]/g, '').slice(0, 100);
      throw new Error(answer ? `Slack answered ${res.status}: ${answer}` : `Slack answered ${res.status}`);
    }
  },

  async weldchat(ctx, channelId, message, locale) {
    if (!(await chatChannelExists(ctx.db, channelId))) throw new Error('The WeldChat channel no longer exists');
    const posted = await postSystemChatMessage(
      {
        db: ctx.db,
        env: ctx.env,
        orgId: ctx.clerkOrgId,
        channelId,
        authorId: WELDPANEL_CHAT_AUTHOR,
        authorName: WELDPANEL_CHAT_AUTHOR_NAME,
        invokerUserId: ctx.actorUserId,
      },
      { content: weldchatContent(ctx, message, locale), metadata: { weldpanel: { kind: message.kind, id: message.entityId } } },
    );
    await publishEntityEventRaw({
      env: ctx.env,
      workspaceId: ctx.clerkOrgId,
      userId: ctx.actorUserId,
      entityType: 'chat_message',
      action: 'created',
      entityId: posted.id,
      data: { id: posted.id, channelId, authorId: WELDPANEL_CHAT_AUTHOR, authorType: 'system' },
    });
  },
};

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

async function attempt(channel: PanelDeliveryChannel, run: () => Promise<SendOutcome | number>): Promise<PanelDeliveryResult> {
  try {
    const outcome = await run();
    if (typeof outcome === 'number') return { channel, ok: true, recipients: outcome, error: null };
    return { channel, ok: outcome.failed === 0, recipients: outcome.sent, error: outcome.failed === 0 ? null : outcome.error };
  } catch (err) {
    return { channel, ok: false, recipients: 0, error: errorText(err) };
  }
}

/** Sends `message` on every channel of `target`; one result per channel tried. Never throws. */
export async function deliver(ctx: DeliveryContext, target: DeliveryTarget, message: PanelMessage): Promise<PanelDeliveryResult[]> {
  const senders: DeliverySenders = { ...defaultSenders, ...ctx.senders };
  const { channels } = target;
  const results: PanelDeliveryResult[] = [];
  let shared: EmailLocale | null = null;
  const sharedLocale = async () => {
    shared ??= await workspaceLocale(ctx.db).catch(() => 'en' as EmailLocale);
    return shared;
  };

  if (channels.emailUserIds.length > 0) {
    results.push(await attempt('email', async () => senders.email(ctx, await memberRecipients(ctx.db, channels.emailUserIds), message)));
  }
  if (channels.inApp) {
    results.push(await attempt('in_app', async () => senders.inApp(ctx, await memberRecipients(ctx.db, [...channels.emailUserIds, target.ownerUserId]), message)));
  }
  if (channels.slack && target.slackWebhookCiphertext) {
    const ciphertext = target.slackWebhookCiphertext;
    results.push(
      await attempt('slack', async () => {
        await senders.slack(ctx, await openSecret(ctx.env, ciphertext), message, await sharedLocale());
        return 1;
      }),
    );
  }
  if (channels.weldchatChannelId) {
    const channelId = channels.weldchatChannelId;
    results.push(
      await attempt('weldchat', async () => {
        await senders.weldchat(ctx, channelId, message, await sharedLocale());
        return 1;
      }),
    );
  }
  return results;
}

/** One line for `lastError` from a delivery, or null when every channel went through. */
export function deliveryError(results: readonly PanelDeliveryResult[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.map((r) => `${r.channel}: ${r.error ?? 'failed'}`).join('; ').slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Storing channels
// ---------------------------------------------------------------------------

/** Channels as stored: the Slack URL sealed in its own column, `slack: true` in the JSON. */
export interface StoredChannels {
  channels: PanelDeliveryChannels;
  slackWebhookCiphertext: string | null;
}

/**
 * The stored form of `input`. `slackWebhookUrl` undefined keeps what `existing`
 * has, null removes it, a URL replaces it (sealed). Throws
 * `SecretsUnavailableError` when a URL must be sealed and no key is configured.
 */
export async function storeChannels(env: Env, input: ParsedPanelDeliveryChannels, existing?: StoredChannels | null): Promise<StoredChannels> {
  let ciphertext = existing?.slackWebhookCiphertext ?? null;
  if (input.slackWebhookUrl === null) ciphertext = null;
  else if (typeof input.slackWebhookUrl === 'string') ciphertext = await sealSecret(env, input.slackWebhookUrl);
  return {
    channels: {
      emailUserIds: input.emailUserIds,
      inApp: input.inApp,
      slack: ciphertext !== null,
      weldchatChannelId: input.weldchatChannelId === undefined ? (existing?.channels.weldchatChannelId ?? null) : input.weldchatChannelId,
    },
    slackWebhookCiphertext: ciphertext,
  };
}

/** Why `input` cannot be saved (an email recipient who is not a member, a WeldChat channel that does not exist), or null. */
export async function channelsProblem(db: Database, input: ParsedPanelDeliveryChannels): Promise<string | null> {
  const unknown = await unknownMembers(db, input.emailUserIds);
  if (unknown.length > 0) return 'Every email recipient must be a member of this workspace';
  if (input.weldchatChannelId && !(await chatChannelExists(db, input.weldchatChannelId))) return 'That WeldChat channel does not exist';
  return null;
}

export function toChannelsDto(stored: StoredChannels): PanelDeliveryChannelsDto {
  return {
    emailUserIds: [...stored.channels.emailUserIds],
    inApp: stored.channels.inApp,
    slack: stored.slackWebhookCiphertext !== null,
    weldchatChannelId: stored.channels.weldchatChannelId ?? null,
  };
}
