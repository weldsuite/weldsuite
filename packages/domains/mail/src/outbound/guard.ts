/**
 * The outbound guard: the one check every send of user-written mail goes
 * through before it reaches Cloudflare, whichever worker sends it (WeldMail
 * compose/reply/forward/scheduled, the public API, CRM sequences, WeldConnect,
 * WeldDesk, personal WeldMail, calendar and WeldMeet invitations).
 *
 *   const reservation = await checkOutbound(env, db, { … });   // may throw OutboundDeniedError
 *   … transmit …
 *   await commitOutbound(env, db, reservation, { waitUntil });  // or releaseOutbound on failure
 *
 * Steps:
 *   1. Sender ownership: the From address must not belong to another
 *      workspace (master `mail_account_registry`). Always enforced.
 *   2. Complaint suppressions: a recipient who reported this workspace's mail
 *      as spam is refused. Always enforced. Always Postgres (`mail_suppressions`),
 *      in every mail-store mode.
 *   3. First contact: recipients who never wrote in. Answered by the
 *      workspace's `MailIndex` object when it is seeded and the caller says
 *      the mail-store mode is `object-only`; otherwise falls back to tenant
 *      Postgres `mail_correspondents`, unchanged.
 *   4. Content screen and template fingerprint (new conversations only).
 *   5. The workspace's `OutboundLedger` Durable Object: limits, state, platform
 *      budget. Its mode (Flagship `weldmail-outbound-guard`: off / shadow /
 *      enforce) decides whether a denial blocks or is only logged.
 *
 * When the ledger can't be reached the guard fails open, behind a per-sender
 * `[[ratelimits]]` backstop: blocking all mail on an infrastructure blip does
 * more harm than a short gap in counting.
 *
 * Pure of Hono: callers pass env, the tenant DB and `waitUntil` themselves.
 * See docs/plans/weldmail-outbound-abuse.md and
 * docs/plans/weldmail-mailbox-store-design.md (decision 1: the mail index is
 * its own EU object, `MailIndex`, not tables on the ledger).
 */

import { and, eq, like } from 'drizzle-orm';
import { getMasterDb, getWorkspaceForOrg, masterSchema, type Database } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import {
  isSharedWeldMailDomain,
  outboundDenialStatus,
  type OutboundDenialCode,
  type OutboundDenialDetails,
  type OutboundGuardMode,
  type OutboundKind,
  type OutboundSource,
  type OutboundUsage,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { screenOutboundContent } from './content-screen';
import { fingerprintTemplate, personalTokensFor } from './fingerprint';
import { findKnownCorrespondents, findSuppressed, recordOutboundCorrespondents } from './correspondents';
import { ledgerKeyFor, type LedgerSubject, type ReserveDecision, type ReserveRequest } from './ledger-core';
import type { OutboundLedger, OutboundPlatformBudget } from './ledger';
import { mailIndexFor } from '../mail-index/client';
import type { MailIndex } from '../mail-index/mail-index';
import type { MailIndexModeHint } from '../mail-index/types';

/** Structural `[[ratelimits]]` binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The bindings the guard reads. Every one is optional: missing ones degrade, never break a send. */
export interface OutboundGuardEnv {
  /** `OutboundLedger` Durable Object (mail-api; `script_name` elsewhere). */
  OUTBOUND_LEDGER?: DurableObjectNamespace<OutboundLedger>;
  /** `OutboundPlatformBudget` Durable Object, for tripping the breaker on Cloudflare's daily-limit error. */
  OUTBOUND_PLATFORM?: DurableObjectNamespace<OutboundPlatformBudget>;
  /**
   * The workspace's `MailIndex` object (mail-api; EU jurisdiction). Optional:
   * workers that haven't bound it yet (it has no `wrangler.toml` entry anywhere
   * so far — a later task adds it) keep working, unchanged, on Postgres.
   */
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;
  /** Per-sender backstop when the ledger is unreachable. */
  OUTBOUND_BACKSTOP?: RateLimitBinding;
  /** Master DB (sender ownership, workspace id) and its KV cache. */
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE?: KVNamespace;
  NEON_API_KEY?: string;
}

export type OutboundSubjectInput =
  | {
      kind: 'workspace';
      clerkOrgId: string;
      /** Master workspace id, when the caller has it (saves a lookup). */
      workspaceId?: string | null;
    }
  | { kind: 'personal'; personalAccountId: string; plan: 'free' | 'pro' };

export interface CheckOutboundInput {
  subject: OutboundSubjectInput;
  source: OutboundSource;
  /** `reply` only when answering a message someone sent to this mailbox. */
  kind: OutboundKind;
  /** The From address, bare or `Name <address>`. */
  from: string;
  /**
   * WeldSuite's own address (calendar and WeldMeet invitations): counted
   * against the workspace, never ownership-checked.
   */
  systemSender?: boolean;
  to: string[];
  cc?: string[] | null;
  bcc?: string[] | null;
  subjectLine?: string | null;
  text?: string | null;
  html?: string | null;
  attachments?: Array<{ filename: string; contentType?: string | null }>;
  /** Recipient display names, so "Hi Anna" and "Hi Bram" fingerprint alike. */
  recipientNames?: string[];
  /** The mailbox's own `dailySendLimit`; lowers the sender's daily limit, never raises it. */
  senderDailyCap?: number | null;
  /**
   * The workspace's mail-store mode, when the caller already knows it (the
   * router, once built, resolves this from Flagship). Unset is treated as not
   * `object-only`, so `MailIndex.firstContacts` is never trusted as
   * authoritative and the guard keeps reading Postgres — today's behaviour.
   */
  mailStoreMode?: MailIndexModeHint;
}

export interface OutboundReservation {
  ledger: { key: string; subject: LedgerSubject } | null;
  reservationId: string | null;
  sender: string;
  recipients: string[];
  firstContact: string[];
  mode: OutboundGuardMode | 'unavailable';
  /** Shadow mode: what enforcement would have refused. */
  shadowDenial?: OutboundDenialDetails;
}

export class OutboundDeniedError extends Error {
  readonly code: OutboundDenialCode;
  readonly status: 403 | 422 | 429;
  constructor(public readonly details: OutboundDenialDetails) {
    super(denialMessage(details));
    this.name = 'OutboundDeniedError';
    this.code = details.code;
    this.status = outboundDenialStatus(details.code);
  }
}

/** English fallback text; clients translate by code. */
export function denialMessage(details: OutboundDenialDetails): string {
  switch (details.code) {
    case 'SENDING_LIMITED':
      return `Sending limit reached (${details.limit ?? '?'} recipients per ${details.window ?? 'day'}).`;
    case 'FIRST_CONTACT_LIMITED':
      return details.reason === 'cold_outreach_template'
        ? 'This message looks like cold outreach and reached its daily limit of new recipients. Use WeldReach for outreach campaigns.'
        : `Limit reached for new recipients who never wrote to you (${details.limit ?? '?'} per day).`;
    case 'SENDING_ON_HOLD':
      return 'New conversations are paused while WeldSuite reviews this workspace. Replies still go out.';
    case 'SENDING_SUSPENDED':
      return 'Sending is suspended for this workspace. Contact WeldSuite support.';
    case 'SENDER_NOT_OWNED':
      return 'This workspace cannot send from that address.';
    case 'TOO_MANY_RECIPIENTS':
      return `Too many recipients in one message (at most ${details.limit ?? '?'}).`;
    case 'RECIPIENT_SUPPRESSED':
      return 'A recipient reported earlier mail from this workspace as spam and cannot be emailed.';
    case 'PLATFORM_LIMITED':
      return 'Mail to new recipients is paused for today. Try again tomorrow.';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `"Anna" <Anna@Example.com>` → `anna@example.com`. */
export function bareAddress(value: string): string {
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf('<');
  const wrapped = open >= 0 && trimmed.endsWith('>');
  return (wrapped ? trimmed.slice(open + 1, -1) : trimmed).trim().toLowerCase();
}

function uniqueAddresses(...lists: Array<string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const address = bareAddress(raw);
      if (address.includes('@')) seen.add(address);
    }
  }
  return [...seen];
}

function hasDbEnv(env: OutboundGuardEnv): env is OutboundGuardEnv & DbEnv {
  return !!env.DATABASE_URL_MASTER && !!env.WORKSPACE_CACHE && !!env.NEON_API_KEY;
}

async function resolveSubject(env: OutboundGuardEnv, input: OutboundSubjectInput): Promise<LedgerSubject | null> {
  if (input.kind === 'personal') return input;
  if (input.workspaceId) return { kind: 'workspace', workspaceId: input.workspaceId, clerkOrgId: input.clerkOrgId };
  if (!hasDbEnv(env)) return null;
  try {
    const { id } = await getWorkspaceForOrg(env, input.clerkOrgId);
    return { kind: 'workspace', workspaceId: id, clerkOrgId: input.clerkOrgId };
  } catch (err) {
    console.warn('[outbound] workspace lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

const OWNERSHIP_TTL_SECONDS = 600;
const { mailAccountRegistry } = masterSchema;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Who owns the From address, as far as the master registry knows:
 * - `owned`: registered to this subject, or nobody claims the address or its
 *   domain (Cloudflare still refuses domains outside the account);
 * - `other`: registered to someone else, or the domain's registered addresses
 *   all belong to other workspaces — always refused;
 * - `unregistered`: on the shared weldmail.com domain with no registry row at
 *   all — refused through the ledger, so shadow mode only logs it (older
 *   accounts may predate the registry; shadow data shows whether they exist).
 */
export type SenderOwnership = 'owned' | 'other' | 'unregistered';

const OWNERSHIP_VALUES: ReadonlySet<string> = new Set(['owned', 'other', 'unregistered']);

type RegistryOwner = { workspaceId: string | null; personalAccountId: string | null };

function ownedBy(subject: LedgerSubject, row: RegistryOwner): boolean {
  return subject.kind === 'workspace'
    ? row.workspaceId === subject.workspaceId
    : row.personalAccountId === subject.personalAccountId;
}

/** The registry's answer for one address. Throws when the master DB can't be reached. */
async function lookupOwnership(databaseUrl: string, subject: LedgerSubject, address: string): Promise<SenderOwnership> {
  const db = getMasterDb({ DATABASE_URL_MASTER: databaseUrl });
  const owner = { workspaceId: mailAccountRegistry.workspaceId, personalAccountId: mailAccountRegistry.personalAccountId };
  const [exact] = await db
    .select(owner)
    .from(mailAccountRegistry)
    .where(and(eq(mailAccountRegistry.email, address), eq(mailAccountRegistry.isActive, true)))
    .limit(1);
  if (exact) return ownedBy(subject, exact) ? 'owned' : 'other';

  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (isSharedWeldMailDomain(domain)) return 'unregistered';

  const rows = await db
    .select(owner)
    .from(mailAccountRegistry)
    .where(and(like(mailAccountRegistry.email, `%@${escapeLike(domain)}`), eq(mailAccountRegistry.isActive, true)))
    .limit(50);
  return rows.length === 0 || rows.some((row) => ownedBy(subject, row)) ? 'owned' : 'other';
}

async function cachedOwnership(env: OutboundGuardEnv, key: string): Promise<SenderOwnership | null> {
  try {
    const cached = await env.WORKSPACE_CACHE?.get(key);
    return cached && OWNERSHIP_VALUES.has(cached) ? (cached as SenderOwnership) : null;
  } catch {
    return null;
  }
}

export async function senderOwnership(
  env: OutboundGuardEnv,
  subject: LedgerSubject,
  address: string,
): Promise<SenderOwnership> {
  if (!env.DATABASE_URL_MASTER) return 'owned';
  const ownerKey = subject.kind === 'workspace' ? subject.workspaceId : `personal:${subject.personalAccountId}`;
  const cacheKey = `outbound:own:${ownerKey}:${address}`;
  const cached = await cachedOwnership(env, cacheKey);
  if (cached) return cached;

  let ownership: SenderOwnership;
  try {
    ownership = await lookupOwnership(env.DATABASE_URL_MASTER, subject, address);
  } catch (err) {
    // Fail open: the registry being down must not stop mail.
    console.warn('[outbound] ownership lookup failed:', err instanceof Error ? err.message : err);
    return 'owned';
  }

  try {
    await env.WORKSPACE_CACHE?.put(cacheKey, ownership, { expirationTtl: OWNERSHIP_TTL_SECONDS });
  } catch {
    // Best effort.
  }
  return ownership;
}

/** True unless the address is registered to someone else. */
export async function isSenderOwned(env: OutboundGuardEnv, subject: LedgerSubject, address: string): Promise<boolean> {
  return (await senderOwnership(env, subject, address)) !== 'other';
}

function ledgerStub(env: OutboundGuardEnv, key: string) {
  const ns = env.OUTBOUND_LEDGER!;
  return ns.get(ns.idFromName(key));
}

async function backstop(env: OutboundGuardEnv, key: string): Promise<void> {
  if (!env.OUTBOUND_BACKSTOP) return;
  try {
    const { success } = await env.OUTBOUND_BACKSTOP.limit({ key });
    if (!success) {
      throw new OutboundDeniedError({
        code: 'SENDING_LIMITED',
        window: 'hour',
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        reason: 'backstop',
      });
    }
  } catch (err) {
    if (err instanceof OutboundDeniedError) throw err;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Check a send and reserve its recipients. Throws {@link OutboundDeniedError}
 * when it must not go out. `db` is the tenant DB (null for personal accounts).
 */
export async function checkOutbound(
  env: OutboundGuardEnv,
  db: Database | null,
  input: CheckOutboundInput,
): Promise<OutboundReservation> {
  const sender = input.systemSender ? '' : bareAddress(input.from);
  const recipients = uniqueAddresses(input.to, input.cc, input.bcc);
  const subject = await resolveSubject(env, input.subject);

  const ownership = subject && !input.systemSender ? await senderOwnership(env, subject, sender) : 'owned';
  if (ownership === 'other') {
    throw new OutboundDeniedError({ code: 'SENDER_NOT_OWNED', reason: 'address_registered_elsewhere' });
  }

  const firstContact = db
    ? await firstContactsOf(env, db, subject, recipients, input.mailStoreMode ?? 'postgres')
    : [];
  const base: Omit<OutboundReservation, 'mode'> = {
    ledger: subject ? { key: ledgerKeyFor(subject), subject } : null,
    reservationId: null,
    sender,
    recipients,
    firstContact,
  };
  if (!subject || !env.OUTBOUND_LEDGER) {
    await backstop(env, `${subject ? ledgerKeyFor(subject) : 'unknown'}:${sender}`);
    return { ...base, mode: 'unavailable' };
  }

  const request = reserveRequestFor(input, base, ownership);
  let decision: ReserveDecision;
  try {
    decision = await ledgerStub(env, ledgerKeyFor(subject)).reserve(subject, request);
  } catch (err) {
    console.error('[outbound] ledger unavailable, failing open:', err instanceof Error ? err.message : err);
    await backstop(env, `${ledgerKeyFor(subject)}:${sender}`);
    return { ...base, mode: 'unavailable' };
  }
  if (!decision.allow && decision.denial) throw new OutboundDeniedError(decision.denial);
  return {
    ...base,
    reservationId: decision.reservationId,
    mode: decision.mode,
    ...(decision.shadowDenial ? { shadowDenial: decision.shadowDenial } : {}),
  };
}

/**
 * The recipients who never wrote to the workspace. Refuses a recipient who
 * complained about earlier mail (always checked against Postgres
 * `mail_suppressions`, in every mail-store mode). On a tenant without the
 * tables yet (not migrated) everyone counts as known.
 *
 * Tries the workspace's `MailIndex` first; its answer is only trusted when it
 * reports itself authoritative (seeded, and the caller says `object-only`).
 * Otherwise — no `MAIL_INDEX` binding, no workspace subject, not seeded, a
 * different mode, or the object throws — this falls back to tenant Postgres
 * `mail_correspondents`, exactly as before `MailIndex` existed.
 */
async function firstContactsOf(
  env: OutboundGuardEnv,
  db: Database,
  subject: LedgerSubject | null,
  recipients: string[],
  mode: MailIndexModeHint,
): Promise<string[]> {
  try {
    const suppressed = (await findSuppressed(db, recipients)).filter((s) => s.reason === 'complaint');
    if (suppressed.length > 0) {
      throw new OutboundDeniedError({ code: 'RECIPIENT_SUPPRESSED', recipients: suppressed.map((s) => s.email) });
    }
    const indexed = await indexedFirstContacts(env, subject, recipients, mode);
    if (indexed) return indexed;
    const known = await findKnownCorrespondents(db, recipients);
    return recipients.filter((r) => !known.has(r));
  } catch (err) {
    if (err instanceof OutboundDeniedError) throw err;
    console.warn('[outbound] correspondent lookup failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** `MailIndex.firstContacts`, or `null` when it isn't available or isn't authoritative — never throws. */
async function indexedFirstContacts(
  env: OutboundGuardEnv,
  subject: LedgerSubject | null,
  recipients: string[],
  mode: MailIndexModeHint,
): Promise<string[] | null> {
  if (!subject || subject.kind !== 'workspace') return null;
  const index = mailIndexFor(env, subject.workspaceId);
  if (!index) return null;
  try {
    const result = await index.firstContacts(subject.workspaceId, recipients, mode);
    return result.authoritative ? result.firstContact : null;
  } catch (err) {
    console.warn('[outbound] mail index lookup failed, falling back to postgres:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** The template fingerprint of a new conversation, or null for replies and short mails. */
function templateOf(input: CheckOutboundInput, recipients: string[]): ReserveRequest['template'] {
  if (input.kind === 'reply' || !(input.text || input.html)) return null;
  const fp = fingerprintTemplate({
    subject: input.subjectLine,
    text: input.text || '',
    personalTokens: personalTokensFor(recipients, input.recipientNames),
  });
  return fp.tooShort ? null : { fingerprint: fp.fingerprint, sample: fp.normalized, subject: input.subjectLine ?? '' };
}

function reserveRequestFor(
  input: CheckOutboundInput,
  base: Pick<OutboundReservation, 'sender' | 'recipients' | 'firstContact'>,
  ownership: SenderOwnership,
): ReserveRequest {
  const content =
    input.kind === 'reply'
      ? null
      : screenOutboundContent({ subject: input.subjectLine, text: input.text, html: input.html, attachments: input.attachments });
  const sender = base.sender;
  return {
    sender,
    source: input.source,
    kind: input.kind,
    recipients: base.recipients,
    firstContact: base.firstContact,
    template: templateOf(input, base.recipients),
    contentScore: content?.score ?? 0,
    contentFlags: content
      ? { coldOutreach: content.flags.coldOutreach, bulk: content.flags.bulk, phishing: content.flags.phishing }
      : undefined,
    sharedDomain: !!sender && isSharedWeldMailDomain(sender.slice(sender.lastIndexOf('@') + 1)),
    senderDailyCap: input.senderDailyCap ?? null,
    senderUnregistered: ownership === 'unregistered',
  };
}

/**
 * Count a send that went out and record its recipients as correspondents.
 * `sentRecipients` narrows a partial send. Never throws.
 */
export async function commitOutbound(
  env: OutboundGuardEnv,
  db: Database | null,
  reservation: OutboundReservation,
  opts: { sentRecipients?: string[]; waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<void> {
  const sent = opts.sentRecipients ? uniqueAddresses(opts.sentRecipients) : reservation.recipients;
  const work = Promise.all([
    commitToLedger(env, reservation, opts.sentRecipients ? sent : undefined),
    recordCorrespondents(db, sent),
    recordOutboundInIndex(env, reservation, sent),
  ]);
  if (opts.waitUntil) opts.waitUntil(work);
  else await work;
}

async function commitToLedger(env: OutboundGuardEnv, reservation: OutboundReservation, sent: string[] | undefined): Promise<void> {
  if (!reservation.ledger || !reservation.reservationId || !env.OUTBOUND_LEDGER) return;
  try {
    await ledgerStub(env, reservation.ledger.key).commit(reservation.reservationId, sent);
  } catch (err) {
    console.error('[outbound] ledger commit failed:', err instanceof Error ? err.message : err);
  }
}

async function recordCorrespondents(db: Database | null, sent: string[]): Promise<void> {
  if (!db || sent.length === 0) return;
  try {
    await recordOutboundCorrespondents(db, sent);
  } catch (err) {
    console.warn('[outbound] correspondent record failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Mirrors the send into the workspace's `MailIndex`, when one is bound —
 * regardless of mail-store mode, so the index stays warm for whenever a
 * workspace flips to `object-only`. Postgres (`recordCorrespondents` above)
 * stays the system of record until the drop PR; this is purely additive.
 */
async function recordOutboundInIndex(env: OutboundGuardEnv, reservation: OutboundReservation, sent: string[]): Promise<void> {
  if (sent.length === 0 || !reservation.ledger || reservation.ledger.subject.kind !== 'workspace') return;
  const index = mailIndexFor(env, reservation.ledger.subject.workspaceId);
  if (!index) return;
  try {
    await index.recordOutbound(reservation.ledger.subject.workspaceId, sent, Date.now());
  } catch (err) {
    console.warn('[outbound] mail index record failed:', err instanceof Error ? err.message : err);
  }
}

/** Give back a reservation whose send never went out. Never throws. */
export async function releaseOutbound(env: OutboundGuardEnv, reservation: OutboundReservation): Promise<void> {
  if (!reservation.ledger || !reservation.reservationId || !env.OUTBOUND_LEDGER) return;
  try {
    await ledgerStub(env, reservation.ledger.key).release(reservation.reservationId);
  } catch (err) {
    console.warn('[outbound] ledger release failed:', err instanceof Error ? err.message : err);
  }
}

/** Cloudflare refused a send with its daily-limit error: trip the platform breaker. Never throws. */
export async function tripPlatformBreaker(env: OutboundGuardEnv, reason: string): Promise<void> {
  if (!env.OUTBOUND_PLATFORM) return;
  try {
    await env.OUTBOUND_PLATFORM.get(env.OUTBOUND_PLATFORM.idFromName('platform')).trip(reason);
  } catch (err) {
    console.error('[outbound] platform breaker trip failed:', err instanceof Error ? err.message : err);
  }
}

/** The customer's view of their limits and usage (mail-api `GET /api/mail-sending/usage`). */
export async function getOutboundUsage(env: OutboundGuardEnv, input: OutboundSubjectInput): Promise<OutboundUsage | null> {
  const subject = await resolveSubject(env, input);
  if (!subject || !env.OUTBOUND_LEDGER) return null;
  return ledgerStub(env, ledgerKeyFor(subject)).usage(subject);
}

/** Wrap a send: check, run, commit — or release when `send` throws before anything went out. */
export async function guardedSend<T>(
  env: OutboundGuardEnv,
  db: Database | null,
  input: CheckOutboundInput,
  send: () => Promise<T>,
  opts: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<T> {
  const reservation = await checkOutbound(env, db, input);
  let result: T;
  try {
    result = await send();
  } catch (err) {
    const sentRecipients = (err as { sentRecipients?: unknown }).sentRecipients;
    if (Array.isArray(sentRecipients) && sentRecipients.length > 0) {
      await commitOutbound(env, db, reservation, { sentRecipients: sentRecipients as string[], waitUntil: opts.waitUntil });
    } else {
      await releaseOutbound(env, reservation);
    }
    throw err;
  }
  await commitOutbound(env, db, reservation, { waitUntil: opts.waitUntil });
  return result;
}
