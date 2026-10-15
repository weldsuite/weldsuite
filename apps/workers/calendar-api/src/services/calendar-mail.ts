/**
 * Calendar attendee mail — invite / reschedule / cancellation.
 *
 * Rendering, i18n, ICS and the Cloudflare Email Service transport all live in
 * `@weldsuite/emails` (the `calendar.event` template) now. This file keeps the
 * calendar-specific plumbing: organizer/member lookups, per-attendee fan-out,
 * SEQUENCE and locale resolution.
 *
 * Pure functions, no Hono context.
 *
 * Every send is best-effort: a mail failure must never fail the mutation
 * that triggered it (each attendee is wrapped in its own try/catch).
 *
 * The mails go out from WeldSuite's own address but carry the organizer's
 * title and description to people the workspace may never have written to, so
 * each batch goes through the outbound mail guard first
 * (`@weldsuite/mail-domain/outbound`, source `calendar`; see
 * docs/plans/weldmail-outbound-abuse.md). A refusal skips the whole batch and
 * is logged, like any other mail failure here: the event stays saved.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  icsAttachment,
  nextIcsSequence,
  resolveEmailLocale,
  sendSystemEmail,
  type CalendarEventKind,
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
import type { Env } from '../types';
import { validTimeZoneOrUndefined } from './calendar-timezone';

export { nextIcsSequence };

/** Optional override of the platform base URL the app links are built from. */
interface AppUrlEnv {
  APP_URL?: string;
}

export function getPlatformUrl(environment: string): string {
  const urls: Record<string, string> = {
    development: 'http://localhost:3000',
    test: 'https://app-test.weldsuite.org',
    preview: 'https://app-preview.weldsuite.org',
    production: 'https://app.weldsuite.org',
  };
  return urls[environment] || 'https://app.weldsuite.org';
}

/**
 * The authenticated calendar deep-link. Only workspace members can open it, so
 * it is never put in a mail to an external guest (see `getMemberEmails`).
 */
function eventUrlFor(env: Env): string {
  const override = (env as Env & AppUrlEnv).APP_URL?.trim().replace(/\/+$/, '');
  return `${override || getPlatformUrl(env.ENVIRONMENT)}/weldcalendar`;
}

// ── Organizer / member lookups ───────────────────────────────────────────

export interface OrganizerInfo {
  name: string;
  email: string;
  /** The organizer's preferred IANA zone; times render in it when the event has none. */
  timezone?: string;
}

/**
 * Resolve the organizer's display name + email from the tenant member table,
 * plus their preferred timezone (`user_preferences`) when they have one.
 */
export async function getOrganizerInfo(
  db: Database,
  userId: string,
): Promise<OrganizerInfo> {
  const { workspaceMembers, userPreferences } = schema;
  const [organizer] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  let timezone: string | undefined;
  try {
    const [prefs] = await db
      .select({ timezone: userPreferences.timezone })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    timezone = validTimeZoneOrUndefined(prefs?.timezone);
  } catch (err) {
    console.error('[calendar-api/calendar-mail] organizer timezone lookup failed:', err);
  }

  return { name: organizer?.name ?? 'Someone', email: organizer?.email ?? '', timezone };
}

/** A workspace member's preferred mail language, when they have one set. */
export interface MemberMailInfo {
  language?: string;
}

/**
 * The lower-cased subset of `emails` that belong to active internal workspace
 * members, each with their preferred language (`user_preferences.language`)
 * when set. Members can open the authenticated calendar; everyone else is a
 * guest.
 */
export async function getMemberEmails(
  db: Database,
  emails: string[],
): Promise<Map<string, MemberMailInfo>> {
  const lowered = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (lowered.length === 0) return new Map();
  const { workspaceMembers, userPreferences } = schema;
  try {
    const rows = await db
      .select({ email: workspaceMembers.email, language: userPreferences.language })
      .from(workspaceMembers)
      .leftJoin(userPreferences, eq(userPreferences.userId, workspaceMembers.userId))
      .where(
        and(
          inArray(sql`lower(${workspaceMembers.email})`, lowered),
          isNull(workspaceMembers.deletedAt),
          eq(workspaceMembers.status, 'ACTIVE'),
          // Outside collaborators are scoped to channels; they have no calendar.
          eq(workspaceMembers.memberType, 'INTERNAL'),
        ),
      );
    const members = new Map<string, MemberMailInfo>();
    for (const row of rows) {
      const email = (row.email ?? '').toLowerCase();
      if (!email) continue;
      members.set(email, { language: row.language ?? undefined });
    }
    return members;
  } catch (err) {
    console.error('[calendar-api/calendar-mail] member lookup failed:', err);
    return new Map();
  }
}

/**
 * The workspace's default mail language (`workspace_settings.language`), used
 * for guests and for members with no language preference of their own.
 */
export async function getWorkspaceLanguage(db: Database): Promise<string | undefined> {
  try {
    const [settings] = await db
      .select({ language: schema.workspaceSettings.language })
      .from(schema.workspaceSettings)
      .limit(1);
    return settings?.language ?? undefined;
  } catch (err) {
    console.error('[calendar-api/calendar-mail] workspace language lookup failed:', err);
    return undefined;
  }
}

// ── Send ──────────────────────────────────────────────────────────────────

export type MailKind = CalendarEventKind;

/** Mails telling the recipient the event is no longer theirs: no join link, no app link. */
const isEndedKind = (kind: MailKind): boolean => kind === 'cancel' || kind === 'removed';

export interface AttendeeLike {
  email?: string | null;
  name?: string | null;
  status?: string | null;
  role?: string | null;
}

/** The event fields the mails need — accepts a DB row or a request body. */
export interface CalendarMailEvent {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Video-conference join link (WeldMeet or third-party). */
  meetingUrl?: string | null;
  /** The event's IANA zone; falls back to the organizer's, then UTC. */
  timezone?: string | null;
  allDay?: boolean | null;
}

/** What the outbound guard needs to count a batch of calendar mail against the workspace. */
export interface OutboundContext {
  /** Tenant DB: who has written to this workspace before (first contact), and who must not be mailed. */
  db: Database;
  /** The workspace's Clerk org id; the guard resolves the master workspace id from it. */
  clerkOrgId: string;
}

/** Options of `sendCalendarEventEmails`. */
export interface SendOptions {
  kind: MailKind;
  event: CalendarMailEvent;
  attendees: AttendeeLike[];
  organizer: OrganizerInfo;
  /** Required, so no caller can send calendar mail past the outbound guard. */
  outbound: OutboundContext;
  /**
   * Floor for the ICS SEQUENCE. Reschedule and cancel mails are always sent
   * with at least `nextIcsSequence()` so they supersede earlier revisions.
   */
  sequence?: number;
  /** Reschedule mails render the previous slot struck through. */
  oldStartTime?: string | null;
  oldEndTime?: string | null;
  /**
   * Members among `attendees`, keyed by lower-cased email (see
   * `getMemberEmails`). Only these recipients get the link into the
   * authenticated calendar; everyone else is an external guest with no
   * account. Omitted means nobody is a member.
   */
  memberEmails?: ReadonlyMap<string, MemberMailInfo>;
  /** The workspace's default mail language; see `getWorkspaceLanguage`. */
  workspaceLanguage?: string;
}

/** The zone the mail shows times in: the event's, else the organizer's, else UTC. */
export function mailTimeZone(event: CalendarMailEvent, organizer: OrganizerInfo): string {
  return (
    validTimeZoneOrUndefined(event.timezone) ??
    validTimeZoneOrUndefined(organizer.timezone) ??
    'UTC'
  );
}

/** WeldSuite's own sending address for system mail (the transport's default From). */
const SYSTEM_SENDER = 'notifications@mail.weldsuite.org';

/** An attendee with an address to mail. */
type Recipient = AttendeeLike & { email: string };

/**
 * Ask the outbound guard once for the whole batch: every attendee gets a
 * message of their own, but they share one title and description, and they
 * count together against the workspace's limits (a new conversation from the
 * `calendar` source, sent from WeldSuite's address, so no sender ownership).
 *
 * Returns the reservation to commit once the mails went out, `'refused'` when
 * the guard said no (the batch is skipped), or `null` when the guard itself
 * failed, which lets the mail through: it fails open, and an invitation is
 * worth more than a gap in counting.
 */
async function reserveBatch(
  env: Env,
  opts: SendOptions,
  recipients: Recipient[],
): Promise<OutboundReservation | 'refused' | null> {
  const { kind, event, outbound } = opts;
  try {
    return await checkOutbound(env, outbound.db, {
      subject: { kind: 'workspace', clerkOrgId: outbound.clerkOrgId },
      source: 'calendar',
      kind: 'new_thread',
      from: SYSTEM_SENDER,
      systemSender: true,
      to: recipients.map((a) => a.email),
      subjectLine: event.title,
      text: event.description,
      recipientNames: recipients.map((a) => a.name).filter((name): name is string => !!name),
    });
  } catch (err) {
    if (err instanceof OutboundDeniedError) {
      console.warn(
        `[calendar-api/calendar-mail] ${kind} mail for event ${event.id} not sent: the outbound guard refused (${err.code})`,
      );
      return 'refused';
    }
    console.error('[calendar-api/calendar-mail] outbound guard failed, sending anyway:', err);
    return null;
  }
}

/** What every mail of one batch shares, worked out once before the fan-out. */
interface BatchMail {
  transport: EmailTransport;
  /** The authenticated calendar link; see `sendAttendeeMail` for who gets it. */
  appUrl: string;
  method: 'REQUEST' | 'CANCEL';
  meetingUrl: string | undefined;
  zone: string;
  sequence: number;
}

function batchMailOf(env: Env, opts: SendOptions, transport: EmailTransport): BatchMail {
  const { kind, event, organizer } = opts;
  return {
    transport,
    appUrl: eventUrlFor(env),
    method: isEndedKind(kind) ? 'CANCEL' : 'REQUEST',
    meetingUrl: isEndedKind(kind) ? undefined : event.meetingUrl?.trim() || undefined,
    zone: mailTimeZone(event, organizer),
    sequence: kind === 'invite' ? (opts.sequence ?? 0) : Math.max(opts.sequence ?? 0, nextIcsSequence()),
  };
}

/** The attendees to mail: skips blank addresses and the organizer's own inbox (legacy parity). */
function recipientsOf(opts: SendOptions): Recipient[] {
  const { organizer } = opts;
  return opts.attendees.filter(
    (a): a is Recipient => !!a.email && a.email.toLowerCase() !== organizer.email?.toLowerCase(),
  );
}

/** Mail one attendee their copy, with the event as an ICS attachment. Throws when the send fails. */
async function sendAttendeeMail(opts: SendOptions, batch: BatchMail, email: string): Promise<void> {
  const { kind, event, organizer } = opts;
  const { method, sequence, zone, meetingUrl } = batch;

  // External guests have no account: the authenticated calendar is a dead
  // end for them, so only members get that link.
  const member = opts.memberEmails?.get(email.toLowerCase());
  const eventUrl = !isEndedKind(kind) && member ? batch.appUrl : undefined;
  const locale = resolveEmailLocale(member?.language, opts.workspaceLanguage);

  const ics = icsAttachment({
    uid: `${event.id}@weldsuite.org`,
    method,
    sequence,
    title: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: event.startTime ?? undefined,
    end: event.endTime ?? undefined,
    allDay: event.allDay ?? undefined,
    timezone: zone,
    organizer: organizer.email ? { email: organizer.email, name: organizer.name } : undefined,
    attendees: [{ email }],
    url: meetingUrl ?? eventUrl,
    meetingUrl,
    product: 'WeldCalendar',
  });

  await sendSystemEmail(batch.transport, {
    template: 'calendar.event',
    props: {
      kind,
      organizerName: organizer.name,
      title: event.title,
      description: event.description ?? undefined,
      startTime: event.startTime ?? undefined,
      endTime: event.endTime ?? undefined,
      oldStartTime: opts.oldStartTime ?? undefined,
      oldEndTime: opts.oldEndTime ?? undefined,
      location: event.location ?? undefined,
      timezone: zone,
      allDay: event.allDay ?? undefined,
      meetingUrl,
      eventUrl,
    },
    to: email,
    locale,
    replyTo: organizer.email || undefined,
    attachments: [ics],
  });
}

/** Count what went out; give the rest back (the commit narrows to `sent`). */
async function settleReservation(
  env: Env,
  opts: SendOptions,
  reservation: OutboundReservation,
  sent: string[],
  recipientCount: number,
): Promise<void> {
  if (sent.length === 0) {
    await releaseOutbound(env, reservation);
    return;
  }
  const partial = sent.length < recipientCount;
  await commitOutbound(env, opts.outbound.db, reservation, partial ? { sentRecipients: sent } : {});
}

/**
 * Send one calendar mail per attendee.
 *
 * No-ops when the worker has no email transport configured (`workerTransport`)
 * or there are no attendees. The organizer is never mailed their own event.
 * The batch goes through the outbound guard first; if it refuses, nothing is
 * sent. Each send is isolated: one bad address does not stop the rest, and
 * nothing here throws to the caller.
 */
export async function sendCalendarEventEmails(env: Env, opts: SendOptions): Promise<void> {
  const transport = workerTransport(env);
  if (!transport || !opts.attendees.length) return;

  const batch = batchMailOf(env, opts, transport);

  const recipients = recipientsOf(opts);
  if (recipients.length === 0) return;

  const reservation = await reserveBatch(env, opts, recipients);
  if (reservation === 'refused') return;

  const sent: string[] = [];
  for (const { email } of recipients) {
    try {
      await sendAttendeeMail(opts, batch, email);
      sent.push(email);
    } catch (err) {
      console.error(`[calendar-api/calendar-mail] ${opts.kind} email failed for ${email}:`, err);
    }
  }

  if (reservation) await settleReservation(env, opts, reservation, sent, recipients.length);
}
