/**
 * WeldSign email: signing requests and reminders, identity codes, "everyone
 * signed", "a signer declined", "the request was voided" and "the request
 * expired", all system mail through @weldsuite/emails from
 * WeldSuite's address, branded as the workspace, Reply-To the sender.
 *
 * Requests carry the sender's own title and message to any address, so a
 * batch goes through the outbound mail guard first (source `sign`), the way
 * calendar invitations do (ADR CAL-004). `sendRequests` reports a refusal so
 * sending can be stopped before anything changes; later mails are best effort.
 */

import {
  resolveEmailLocale,
  sendSystemEmail,
  workspaceAppUrl,
  type EmailBrand,
  type EmailTransport,
} from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import {
  OutboundDeniedError,
  checkOutbound,
  commitOutbound,
  releaseOutbound,
  type OutboundReservation,
} from '@weldsuite/mail-domain/outbound';
import { getMasterDb, masterSchema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { SignEnvelope, SignRecipient } from '@weldsuite/db/schema';
import type { SignEnv as Env } from './env';
import { loadSignBrand } from './settings';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

const SYSTEM_SENDER = 'notifications@mail.weldsuite.org';

/** Signed PDFs up to this size travel as an attachment; larger ones only as a link. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function platformUrl(environment: string | undefined): string {
  const urls: Record<string, string> = {
    development: 'http://localhost:3000',
    test: 'https://app-test.weldsuite.org',
    production: 'https://app.weldsuite.org',
  };
  return urls[environment ?? ''] ?? 'https://app.weldsuite.org';
}

/** The request in the platform, for the sender (FE-013 workspace URL). */
export function envelopeAppUrl(env: Env, clerkOrgId: string, envelopeId: string): string {
  return workspaceAppUrl(platformUrl(env.ENVIRONMENT), clerkOrgId, `/weldsign/${envelopeId}`);
}

export interface MailContext {
  env: Env;
  db: Database;
  clerkOrgId: string;
  envelope: SignEnvelope;
  /** Master DB handle when the caller has one (saves a connection). */
  master?: MasterDatabase;
}

/** The workspace's name (its WeldSign brand name when set), colour and logo. */
export async function workspaceBrand(ctx: Pick<MailContext, 'env' | 'db' | 'clerkOrgId' | 'master'>): Promise<{ brand: EmailBrand; name: string }> {
  const settings = await loadSignBrand(ctx.db);
  let name = settings.name;
  if (!name) {
    try {
      const [row] = await (ctx.master ?? getMasterDb(ctx.env))
        .select({ name: masterSchema.workspaces.name })
        .from(masterSchema.workspaces)
        .where(matchWorkspaceRef(ctx.clerkOrgId))
        .limit(1);
      name = row?.name ?? null;
    } catch (err) {
      console.warn('[sign-api/mail] workspace name lookup failed:', err);
    }
  }
  const display = name || 'WeldSuite';
  return {
    name: display,
    brand: { kind: 'workspace', name: display, logoUrl: settings.logoUrl, accentColor: settings.color },
  };
}

const locale = (r: Pick<SignRecipient, 'locale'>) => resolveEmailLocale(r.locale, undefined);

async function reserve(ctx: MailContext, to: string[], names: string[]): Promise<OutboundReservation | 'refused' | null> {
  try {
    return await checkOutbound(ctx.env, ctx.db, {
      subject: { kind: 'workspace', clerkOrgId: ctx.clerkOrgId },
      source: 'sign',
      kind: 'new_thread',
      from: SYSTEM_SENDER,
      systemSender: true,
      to,
      subjectLine: ctx.envelope.title,
      text: ctx.envelope.message,
      recipientNames: names,
    });
  } catch (err) {
    if (err instanceof OutboundDeniedError) {
      console.warn(`[sign-api/mail] mail for envelope ${ctx.envelope.id} refused by the outbound guard (${err.code})`);
      return 'refused';
    }
    // The guard fails open: a signing request is worth more than a gap in counting.
    console.error('[sign-api/mail] outbound guard failed, sending anyway:', err);
    return null;
  }
}

async function settle(ctx: MailContext, reservation: OutboundReservation | null, sent: string[], total: number): Promise<void> {
  if (!reservation) return;
  if (sent.length === 0) await releaseOutbound(ctx.env, reservation);
  else await commitOutbound(ctx.env, ctx.db, reservation, sent.length < total ? { sentRecipients: sent } : {});
}

function transportOf(env: Env): EmailTransport | undefined {
  return workerTransport(env);
}

export interface RequestMail {
  recipient: Pick<SignRecipient, 'name' | 'email' | 'locale'>;
  url: string;
}

/**
 * Send signing requests (or reminders of one). `'refused'` when the outbound
 * guard said no (nothing was sent); otherwise the addresses that went out.
 */
export async function sendRequests(ctx: MailContext, mails: RequestMail[], opts: { reminder?: boolean } = {}): Promise<'refused' | string[]> {
  const list = mails.filter((m): m is RequestMail & { recipient: { email: string } } => !!m.recipient.email);
  if (list.length === 0) return [];
  const reservation = await reserve(
    ctx,
    list.map((m) => m.recipient.email),
    list.map((m) => m.recipient.name ?? '').filter(Boolean),
  );
  if (reservation === 'refused') return 'refused';
  const transport = transportOf(ctx.env);
  if (!transport) {
    console.warn('[sign-api/mail] no email transport configured; signing requests not sent');
    if (reservation) await releaseOutbound(ctx.env, reservation);
    return [];
  }
  const { brand, name: workspaceName } = await workspaceBrand(ctx);
  const sender = ctx.envelope.senderName || workspaceName;
  const sent: string[] = [];
  for (const mail of list) {
    try {
      await sendSystemEmail(transport, {
        template: 'sign.request',
        props: {
          senderName: sender,
          title: ctx.envelope.title,
          message: ctx.envelope.message,
          url: mail.url,
          expiresAt: ctx.envelope.expiresAt?.toISOString() ?? null,
          reminder: opts.reminder ?? false,
        },
        to: mail.recipient.email,
        locale: locale(mail.recipient),
        brand,
        replyTo: ctx.envelope.senderEmail ?? undefined,
      });
      sent.push(mail.recipient.email);
    } catch (err) {
      console.error(`[sign-api/mail] signing request to recipient of ${ctx.envelope.id} failed:`, err);
    }
  }
  await settle(ctx, reservation, sent, list.length);
  return sent;
}

/** The one-time code for opening a link. Not counted by the guard: it only goes to someone already invited. */
export async function sendCode(ctx: MailContext, recipient: Pick<SignRecipient, 'email' | 'locale'>, code: string, minutes: number): Promise<boolean> {
  const transport = transportOf(ctx.env);
  if (!transport || !recipient.email) return false;
  const { brand } = await workspaceBrand(ctx);
  try {
    await sendSystemEmail(transport, {
      template: 'sign.code',
      props: { title: ctx.envelope.title, code, expiresInMinutes: minutes },
      to: recipient.email,
      locale: locale(recipient),
      brand,
    });
    return true;
  } catch (err) {
    console.error(`[sign-api/mail] code email for ${ctx.envelope.id} failed:`, err);
    return false;
  }
}

export interface CompletedMail {
  to: string;
  locale: string;
  /** Portal link for signers and copy recipients, the request in WeldSuite for the sender. */
  url: string | null;
  forSender: boolean;
}

/** "Everyone signed", with the PDF attached when it is small enough. Best effort. */
export async function sendCompleted(ctx: MailContext, mails: CompletedMail[], signers: string[], pdf: Uint8Array): Promise<void> {
  const transport = transportOf(ctx.env);
  if (!transport || mails.length === 0) return;
  const { brand } = await workspaceBrand(ctx);
  const attach = pdf.byteLength <= MAX_ATTACHMENT_BYTES;
  const filename = `${ctx.envelope.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'signed'}.pdf`;
  for (const mail of mails) {
    try {
      await sendSystemEmail(transport, {
        template: 'sign.completed',
        props: { title: ctx.envelope.title, signers, attached: attach, url: mail.url, forSender: mail.forSender },
        to: mail.to,
        locale: resolveEmailLocale(mail.locale, undefined),
        brand: mail.forSender ? { kind: 'weldsuite', module: 'WeldSign' } : brand,
        replyTo: mail.forSender ? undefined : (ctx.envelope.senderEmail ?? undefined),
        attachments: attach ? [{ filename, content: pdf, contentType: 'application/pdf' }] : undefined,
      });
    } catch (err) {
      console.error(`[sign-api/mail] completed email for ${ctx.envelope.id} failed:`, err);
    }
  }
}

/**
 * Tell signers who already got the request that it was voided, with the
 * sender's reason. Not counted by the guard: it only goes to people already
 * invited. Best effort.
 */
export async function sendVoided(ctx: MailContext, recipients: Pick<SignRecipient, 'email' | 'locale'>[], reason: string): Promise<void> {
  const transport = transportOf(ctx.env);
  if (!transport || recipients.length === 0) return;
  const { brand, name: workspaceName } = await workspaceBrand(ctx);
  for (const r of recipients) {
    if (!r.email) continue;
    try {
      await sendSystemEmail(transport, {
        template: 'sign.voided',
        props: { senderName: ctx.envelope.senderName || workspaceName, title: ctx.envelope.title, reason },
        to: r.email,
        locale: locale(r),
        brand,
        replyTo: ctx.envelope.senderEmail ?? undefined,
      });
    } catch (err) {
      console.error(`[sign-api/mail] voided email for ${ctx.envelope.id} failed:`, err);
    }
  }
}

/** Tell the sender a request expired before everyone signed. Best effort. */
export async function sendExpired(ctx: MailContext, unsigned: string[]): Promise<void> {
  const transport = transportOf(ctx.env);
  if (!transport || !ctx.envelope.senderEmail) return;
  try {
    await sendSystemEmail(transport, {
      template: 'sign.expired',
      props: { title: ctx.envelope.title, unsigned, url: envelopeAppUrl(ctx.env, ctx.clerkOrgId, ctx.envelope.id) },
      to: ctx.envelope.senderEmail,
      locale: resolveEmailLocale(null, undefined),
      brand: { kind: 'weldsuite', module: 'WeldSign' },
    });
  } catch (err) {
    console.error(`[sign-api/mail] expired email for ${ctx.envelope.id} failed:`, err);
  }
}

/** Tell the sender a signer declined. Best effort. */
export async function sendDeclined(ctx: MailContext, declinedBy: string, reason: string, senderLocale: string | null): Promise<void> {
  const transport = transportOf(ctx.env);
  if (!transport || !ctx.envelope.senderEmail) return;
  try {
    await sendSystemEmail(transport, {
      template: 'sign.declined',
      props: { title: ctx.envelope.title, declinedBy, reason, url: envelopeAppUrl(ctx.env, ctx.clerkOrgId, ctx.envelope.id) },
      to: ctx.envelope.senderEmail,
      locale: resolveEmailLocale(senderLocale, undefined),
      brand: { kind: 'weldsuite', module: 'WeldSign' },
    });
  } catch (err) {
    console.error(`[sign-api/mail] declined email for ${ctx.envelope.id} failed:`, err);
  }
}
