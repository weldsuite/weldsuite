/**
 * WeldForms email: invitations and reminders, the receipt, new-response mails
 * to subscribers, the daily digest, the quota notices and the code of a
 * verified-email form. All system mail through @weldsuite/emails from
 * WeldSuite's address, branded as the workspace.
 *
 * Mail that carries the sender's own words to any address (invitations,
 * reminders) and the codes anyone can trigger go through the outbound mail
 * guard first (source `forms`, ADR MAIL-006). `sendInvitationMails` reports a
 * refusal so sending can be stopped before anything changes; the other mails
 * are best effort.
 */

import { eq } from 'drizzle-orm';
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
import { masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { formThemeTokensSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import type { Env } from '../types';
import type { WorkspaceCtx } from './context';

const { forms, formVersions, formThemes, formSettings } = schema;
const { workspaces } = masterSchema;

export const SYSTEM_SENDER = 'notifications@mail.weldsuite.org';

type FormRow = typeof forms.$inferSelect;

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

export interface FormsBrand {
  brand: EmailBrand;
  /** Shown as the sender of invitations: the workspace's forms sender name, else its name. */
  senderName: string;
  workspaceName: string;
}

/** The workspace's name and, when the form has one, its logo and button colour. */
export async function formsBrand(ctx: Pick<WorkspaceCtx, 'db' | 'master' | 'workspaceId'>, form: Pick<FormRow, 'publishedVersionId' | 'themeId'> | null): Promise<FormsBrand> {
  const [[workspace], [settings]] = await Promise.all([
    ctx.master.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    ctx.db.select({ senderName: formSettings.senderName }).from(formSettings).limit(1),
  ]);
  let tokens: unknown = null;
  if (form?.publishedVersionId) {
    [{ theme: tokens } = { theme: null }] = await ctx.db.select({ theme: formVersions.theme }).from(formVersions).where(eq(formVersions.id, form.publishedVersionId)).limit(1);
  } else if (form?.themeId) {
    [{ theme: tokens } = { theme: null }] = await ctx.db.select({ theme: formThemes.tokens }).from(formThemes).where(eq(formThemes.id, form.themeId)).limit(1);
  }
  const theme = tokens ? formThemeTokensSchema.safeParse(tokens) : null;
  const workspaceName = workspace?.name || 'WeldSuite';
  return {
    workspaceName,
    senderName: settings?.senderName?.trim() || workspaceName,
    brand: {
      kind: 'workspace',
      name: settings?.senderName?.trim() || workspaceName,
      logoUrl: theme?.success ? (theme.data.logoUrl ?? null) : null,
      accentColor: theme?.success ? theme.data.colors.button : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const portalOrigin = (env: Pick<Env, 'FORMS_PORTAL_URL'>) => (env.FORMS_PORTAL_URL || 'https://forms.weldsuite.org').replace(/\/$/, '');
const platformOrigin = (env: Pick<Env, 'PLATFORM_URL'>) => (env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/$/, '');

/** A person's personal link, the form forms-portal opens: `/i/<publicId>.<token>`. */
export const invitationUrl = (env: Pick<Env, 'FORMS_PORTAL_URL'>, publicId: string, token: string) => `${portalOrigin(env)}/i/${publicId}.${token}`;

/** The form's results in the platform, in the workspace (FE-013). */
export const resultsUrl = (env: Pick<Env, 'PLATFORM_URL'>, clerkOrgId: string, formId: string, query = 'tab=responses') =>
  workspaceAppUrl(platformOrigin(env), clerkOrgId, `/weldforms/${formId}/results?${query}`);

export const plansUrl = (env: Pick<Env, 'PLATFORM_URL'>, clerkOrgId: string) => workspaceAppUrl(platformOrigin(env), clerkOrgId, '/settings/billing');

// ---------------------------------------------------------------------------
// Outbound guard
// ---------------------------------------------------------------------------

export interface GuardInput {
  to: string[];
  names?: string[];
  subjectLine?: string | null;
  text?: string | null;
}

/**
 * Reserves a send with the outbound guard. `'refused'`: it said no, send nothing.
 * `null`: the guard failed, which is open (a form's mail is worth more than a
 * gap in counting).
 */
export async function reserveOutboundMail(env: Env, db: Database | null, clerkOrgId: string, input: GuardInput): Promise<OutboundReservation | 'refused' | null> {
  try {
    return await checkOutbound(env, db, {
      subject: { kind: 'workspace', clerkOrgId },
      source: 'forms',
      kind: 'new_thread',
      from: SYSTEM_SENDER,
      systemSender: true,
      to: input.to,
      subjectLine: input.subjectLine ?? null,
      text: input.text ?? null,
      recipientNames: input.names ?? [],
    });
  } catch (err) {
    if (err instanceof OutboundDeniedError) {
      console.warn(`[forms-api/mail] mail refused by the outbound guard (${err.code})`);
      return 'refused';
    }
    console.error('[forms-api/mail] outbound guard failed, sending anyway:', err);
    return null;
  }
}

export async function settleOutboundMail(env: Env, db: Database | null, reservation: OutboundReservation | null, sent: string[], total: number): Promise<void> {
  if (!reservation) return;
  if (sent.length === 0) await releaseOutbound(env, reservation);
  else await commitOutbound(env, db, reservation, sent.length < total ? { sentRecipients: sent } : {});
}

const transportOf = (env: Env): EmailTransport | undefined => workerTransport(env);

// ---------------------------------------------------------------------------
// Invitations and reminders
// ---------------------------------------------------------------------------

export interface InviteMail {
  email: string;
  name: string | null;
  locale: string;
  url: string;
  subject: string | null;
  message: string | null;
}

export interface InviteMailContext {
  env: Env;
  db: Database;
  master: WorkspaceCtx['master'];
  clerkOrgId: string;
  workspaceId: string;
  form: FormRow;
  definition: FormDefinition | null;
  senderEmail?: string | null;
  closesAt?: string | null;
}

/**
 * Sends invitations (or reminders of them): the whole batch is checked by the
 * outbound guard first. `'refused'` when it said no (nothing was sent);
 * otherwise the addresses that went out.
 */
export async function sendInvitationMails(
  ctx: InviteMailContext,
  mails: InviteMail[],
  opts: { reminder?: boolean; /** A reservation the caller already made (it checked the batch before changing anything); `null`: the guard was unavailable. */ reservation?: OutboundReservation | null } = {},
): Promise<'refused' | string[]> {
  if (mails.length === 0) return [];
  const reservation =
    opts.reservation !== undefined
      ? opts.reservation
      : await reserveOutboundMail(ctx.env, ctx.db, ctx.clerkOrgId, {
          to: mails.map((m) => m.email),
          names: mails.map((m) => m.name ?? '').filter(Boolean),
          subjectLine: mails[0]!.subject ?? ctx.form.title,
          text: mails[0]!.message,
        });
  if (reservation === 'refused') return 'refused';
  const transport = transportOf(ctx.env);
  if (!transport) {
    console.warn('[forms-api/mail] no email transport configured; invitations not sent');
    if (reservation) await releaseOutbound(ctx.env, reservation);
    return [];
  }
  const { brand, senderName } = await formsBrand(ctx, ctx.form);
  const sent: string[] = [];
  for (const mail of mails) {
    try {
      await sendSystemEmail(transport, {
        template: 'forms.invite',
        props: {
          senderName,
          title: ctx.form.title,
          subject: mail.subject,
          message: mail.message,
          url: mail.url,
          closesAt: ctx.closesAt ?? null,
          reminder: opts.reminder ?? false,
        },
        to: mail.name ? { email: mail.email, name: mail.name } : mail.email,
        locale: resolveEmailLocale(mail.locale, ctx.definition?.presentation.language),
        brand,
        replyTo: ctx.senderEmail ?? undefined,
      });
      sent.push(mail.email);
    } catch (err) {
      console.error(`[forms-api/mail] invitation for form ${ctx.form.id} failed:`, err);
    }
  }
  await settleOutboundMail(ctx.env, ctx.db, reservation, sent, mails.length);
  return sent;
}

// ---------------------------------------------------------------------------
// Receipt, responses, digest, quota
// ---------------------------------------------------------------------------

export interface QA {
  question: string;
  answer: string;
}

export async function sendReceiptMail(
  ctx: Pick<WorkspaceCtx, 'env' | 'db' | 'master' | 'workspaceId'>,
  form: FormRow,
  definition: FormDefinition,
  to: string,
  number: number | null,
  answers: QA[],
): Promise<boolean> {
  const transport = transportOf(ctx.env);
  if (!transport || answers.length === 0) return false;
  const { brand } = await formsBrand(ctx, form);
  try {
    await sendSystemEmail(transport, {
      template: 'forms.receipt',
      props: { title: form.title, number, answers },
      to,
      locale: resolveEmailLocale(definition.presentation.language),
      brand,
    });
    return true;
  } catch (err) {
    console.error(`[forms-api/mail] receipt for form ${form.id} failed:`, err);
    return false;
  }
}

export interface MemberRecipient {
  userId: string;
  email: string;
  name: string | null;
}

export async function sendResponseMail(
  ctx: Pick<WorkspaceCtx, 'env' | 'db' | 'master' | 'workspaceId' | 'clerkOrgId'>,
  form: FormRow,
  to: MemberRecipient,
  props: { number: number | null; respondent: string | null; answers: QA[] | null; responseId: string },
): Promise<boolean> {
  const transport = transportOf(ctx.env);
  if (!transport) return false;
  try {
    await sendSystemEmail(transport, {
      template: 'forms.response',
      props: { title: form.title, number: props.number, respondent: props.respondent, answers: props.answers, url: resultsUrl(ctx.env, ctx.clerkOrgId, form.id, `tab=responses&response=${props.responseId}`) },
      to: to.email,
      locale: resolveEmailLocale(null),
      brand: { kind: 'weldsuite', module: 'WeldForms' },
    });
    return true;
  } catch (err) {
    console.error(`[forms-api/mail] response mail for form ${form.id} failed:`, err);
    return false;
  }
}

export async function sendDigestMail(
  ctx: Pick<WorkspaceCtx, 'env' | 'db' | 'master' | 'workspaceId' | 'clerkOrgId'>,
  form: FormRow,
  to: MemberRecipient,
  props: { count: number; responses: Array<{ number: number | null; respondent: string | null; summary: string | null }> },
): Promise<boolean> {
  const transport = transportOf(ctx.env);
  if (!transport) return false;
  const { workspaceName } = await formsBrand(ctx, form);
  try {
    await sendSystemEmail(transport, {
      template: 'forms.digest',
      props: { title: form.title, workspaceName, count: props.count, responses: props.responses, url: resultsUrl(ctx.env, ctx.clerkOrgId, form.id) },
      to: to.email,
      locale: resolveEmailLocale(null),
      brand: { kind: 'weldsuite', module: 'WeldForms' },
    });
    return true;
  } catch (err) {
    console.error(`[forms-api/mail] digest for form ${form.id} failed:`, err);
    return false;
  }
}

export async function sendQuotaMail(
  ctx: Pick<WorkspaceCtx, 'env' | 'clerkOrgId'>,
  to: MemberRecipient,
  props: { workspaceName: string; percent: 80 | 100; used: number; limit: number; resetsAt: string },
): Promise<boolean> {
  const transport = transportOf(ctx.env);
  if (!transport) return false;
  try {
    await sendSystemEmail(transport, {
      template: 'forms.quota',
      props: { ...props, url: plansUrl(ctx.env, ctx.clerkOrgId) },
      to: to.email,
      locale: resolveEmailLocale(null),
      brand: { kind: 'weldsuite', module: 'WeldForms' },
    });
    return true;
  } catch (err) {
    console.error('[forms-api/mail] quota mail failed:', err);
    return false;
  }
}
