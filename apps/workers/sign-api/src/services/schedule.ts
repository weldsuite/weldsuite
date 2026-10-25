/**
 * When a workspace next has lifecycle work: a reminder to a signer whose turn
 * it is, or an open request reaching its expiry. The lifecycle sweep
 * (cron/lifecycle-sweep.ts) opens a tenant DB only when the D1 due index
 * (kind `sign_lifecycle`) says so; write paths that can bring new work
 * forward (sending, the next signing group, a corrected email) re-derive it
 * with `scheduleLifecycle`.
 *
 * Reminders (per request, defaults from `sign_settings`): the first
 * `reminderAfterDays` after the link was sent, then every `reminderEveryDays`
 * (or once more after `reminderAfterDays` when unset), at most
 * `reminderMaxCount` automatic ones, never at or after the expiry. A reminder
 * sent by hand moves the next automatic one a full interval on, without
 * counting towards the maximum.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { syncWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { SignEnvelope, SignRecipient } from '@weldsuite/db/schema';
import type { Env } from '../types';

const { signEnvelopes, signRecipients } = schema;

const DAY_MS = 86_400_000;

/** Applied when a request has a reminder delay but no maximum. */
export const DEFAULT_REMINDER_MAX = 3;

type ReminderSettings = Pick<SignEnvelope, 'reminderAfterDays' | 'reminderEveryDays' | 'reminderMaxCount' | 'expiresAt'>;
type ReminderState = Pick<SignRecipient, 'role' | 'status' | 'sentAt' | 'lastRemindedAt' | 'remindersSent'>;

/** A signer whose turn it is: emailed, not yet signed or declined. */
export function isCurrentSigner(r: Pick<SignRecipient, 'role' | 'status'>): boolean {
  return r.role === 'signer' && (r.status === 'sent' || r.status === 'opened');
}

/** When this signer's next automatic reminder is due, or null when none is left. */
export function nextReminderAt(envelope: ReminderSettings, r: ReminderState): Date | null {
  if (!isCurrentSigner(r) || !r.sentAt || !envelope.reminderAfterDays) return null;
  if (r.remindersSent >= (envelope.reminderMaxCount ?? DEFAULT_REMINDER_MAX)) return null;
  const first = r.sentAt.getTime() + envelope.reminderAfterDays * DAY_MS;
  let at = first;
  if (r.lastRemindedAt) {
    const every = envelope.reminderEveryDays ?? envelope.reminderAfterDays;
    at = Math.max(first, r.lastRemindedAt.getTime() + every * DAY_MS);
  }
  if (envelope.expiresAt && at >= envelope.expiresAt.getTime()) return null;
  return new Date(at);
}

/** Open requests with their signers, for the sweep and for working out the next due time. */
export async function openRequests(db: Database): Promise<Array<{ envelope: SignEnvelope; signers: SignRecipient[] }>> {
  const envelopes = await db
    .select()
    .from(signEnvelopes)
    .where(and(eq(signEnvelopes.kind, 'envelope'), inArray(signEnvelopes.status, ['sent', 'in_progress']), isNull(signEnvelopes.deletedAt)));
  if (envelopes.length === 0) return [];
  const signers = await db
    .select()
    .from(signRecipients)
    .where(and(inArray(signRecipients.envelopeId, envelopes.map((e) => e.id)), eq(signRecipients.role, 'signer')));
  return envelopes.map((envelope) => ({ envelope, signers: signers.filter((s) => s.envelopeId === envelope.id) }));
}

/**
 * Everyone signed: the request waits for its signed PDF, which is the
 * finalize step's job. It neither expires nor needs reminders.
 */
export function allSigned(signers: Pick<SignRecipient, 'status'>[]): boolean {
  return signers.length > 0 && signers.every((s) => s.status === 'signed');
}

/** The earliest reminder or expiry among open requests, or null when there is none. */
export async function nextLifecycleDueAt(db: Database): Promise<Date | null> {
  let earliest: number | null = null;
  const consider = (at: Date | null) => {
    if (at && (earliest === null || at.getTime() < earliest)) earliest = at.getTime();
  };
  for (const { envelope, signers } of await openRequests(db)) {
    if (allSigned(signers)) continue;
    consider(envelope.expiresAt);
    for (const s of signers) consider(nextReminderAt(envelope, s));
  }
  return earliest === null ? null : new Date(earliest);
}

/** Tell the lifecycle sweep when to look at this workspace next. Best effort. */
export async function scheduleLifecycle(env: Pick<Env, 'SCHEDULE_INDEX'>, db: Database, clerkOrgId: string): Promise<void> {
  await syncWorkspaceDue(env.SCHEDULE_INDEX, 'sign_lifecycle', clerkOrgId, () => nextLifecycleDueAt(db));
}
