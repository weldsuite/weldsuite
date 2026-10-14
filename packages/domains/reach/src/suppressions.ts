/**
 * The suppression list: addresses and whole domains WeldReach must never email.
 *
 * Checked at import, when prospects are enrolled and right before every send.
 * A domain entry covers its subdomains too (`example.com` also blocks
 * `mail.example.com`). Entries are never removed automatically.
 */

import { and, desc, eq, ilike, inArray, isNull, like, or } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  emailDomain,
  type ReachSuppression as ReachSuppressionDto,
  type ReachSuppressionReason,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachEnrollments,
  reachProspects,
  reachSuppressions,
  type ReachSuppression,
} from '@weldsuite/db/schema';
import { completeAndPublishCampaigns } from './campaign-completion';
import { reachError } from './errors';
import type { ReachEventSink } from './events';
import { cursorCondition, likePattern, pageResult, parseLimit, type Page, type PageQuery } from './list-query';
import { isValidEmailSyntax } from './validation';

export interface SuppressionHit {
  value: string;
  type: 'email' | 'domain';
  reason: ReachSuppressionReason;
}

/** `a.b.example.com` -> itself and every parent that still has a dot (never the bare TLD). */
export function domainSuffixes(domain: string): string[] {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 1 < labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** In-memory lookup over the suppression rows relevant to a batch of emails. */
export class SuppressionIndex {
  constructor(
    private readonly emails: ReadonlyMap<string, SuppressionHit>,
    private readonly domains: ReadonlyMap<string, SuppressionHit>,
  ) {}

  /** The entry that suppresses this (lower-cased) address, if any. */
  check(email: string): SuppressionHit | null {
    const direct = this.emails.get(email);
    if (direct) return direct;
    for (const suffix of domainSuffixes(emailDomain(email))) {
      const hit = this.domains.get(suffix);
      if (hit) return hit;
    }
    return null;
  }

  static empty(): SuppressionIndex {
    return new SuppressionIndex(new Map(), new Map());
  }
}

const LOOKUP_CHUNK = 1000;

/** Load exactly the suppression rows that can apply to `emails`. */
export async function loadSuppressionIndex(db: Database, emails: readonly string[]): Promise<SuppressionIndex> {
  const wanted = new Set<string>();
  for (const email of emails) {
    wanted.add(email);
    for (const suffix of domainSuffixes(emailDomain(email))) wanted.add(suffix);
  }
  const values = [...wanted];
  const emailMap = new Map<string, SuppressionHit>();
  const domainMap = new Map<string, SuppressionHit>();

  for (let i = 0; i < values.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .select({ value: reachSuppressions.value, type: reachSuppressions.type, reason: reachSuppressions.reason })
      .from(reachSuppressions)
      .where(inArray(reachSuppressions.value, values.slice(i, i + LOOKUP_CHUNK)));
    for (const row of rows) (row.type === 'domain' ? domainMap : emailMap).set(row.value, row);
  }
  return new SuppressionIndex(emailMap, domainMap);
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A pasted value as a suppression entry: an address when it has a local part,
 * a domain otherwise (`@example.com` and `example.com` are both the domain).
 * null when it is neither.
 */
export function normalizeSuppressionValue(raw: string): { value: string; type: 'email' | 'domain' } | null {
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value.startsWith('@')) {
    const domain = value.slice(1);
    return DOMAIN_RE.test(domain) ? { value: domain, type: 'domain' } : null;
  }
  if (value.includes('@')) return isValidEmailSyntax(value) ? { value, type: 'email' } : null;
  return DOMAIN_RE.test(value) ? { value, type: 'domain' } : null;
}

export interface AddSuppressionsOptions {
  reason: ReachSuppressionReason;
  source?: string | null;
  createdBy?: string | null;
}

export interface AddSuppressionsResult {
  /** Entries newly stored. */
  added: number;
  /** Values that were malformed or already on the list. */
  skipped: number;
  /** The entries that were added. */
  entries: Array<{ value: string; type: 'email' | 'domain' }>;
}

const INSERT_CHUNK = 500;

export async function addSuppressions(
  db: Database,
  rawValues: readonly string[],
  options: AddSuppressionsOptions,
): Promise<AddSuppressionsResult> {
  const unique = new Map<string, { value: string; type: 'email' | 'domain' }>();
  for (const raw of rawValues) {
    const entry = normalizeSuppressionValue(raw);
    if (entry) unique.set(entry.value, entry);
  }
  const entries = [...unique.values()];
  const added: AddSuppressionsResult['entries'] = [];

  for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
    const chunk = entries.slice(i, i + INSERT_CHUNK);
    const inserted = await db
      .insert(reachSuppressions)
      .values(
        chunk.map((e) => ({
          id: generateId('rsup'),
          value: e.value,
          type: e.type,
          reason: options.reason,
          source: options.source ?? null,
          createdBy: options.createdBy ?? null,
        })),
      )
      .onConflictDoNothing({ target: reachSuppressions.value })
      .returning({ value: reachSuppressions.value, type: reachSuppressions.type });
    added.push(...inserted);
  }

  return { added: added.length, skipped: rawValues.length - added.length, entries: added };
}

/** Suppress one address (a bounce or an unsubscribe). Idempotent. */
export async function suppressEmail(
  db: Database,
  email: string,
  reason: ReachSuppressionReason,
  source: string | null,
  createdBy: string | null = null,
): Promise<void> {
  await db
    .insert(reachSuppressions)
    .values({ id: generateId('rsup'), value: email.toLowerCase(), type: 'email', reason, source, createdBy })
    .onConflictDoNothing({ target: reachSuppressions.value });
}

export function toSuppressionDto(row: ReachSuppression): ReachSuppressionDto {
  return {
    id: row.id,
    value: row.value,
    type: row.type,
    reason: row.reason,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function prospectMatches(entries: ReadonlyArray<{ value: string; type: 'email' | 'domain' }>) {
  const emails = entries.filter((e) => e.type === 'email').map((e) => e.value);
  const domains = entries.filter((e) => e.type === 'domain').map((e) => e.value);
  return or(
    emails.length > 0 ? inArray(reachProspects.email, emails) : undefined,
    domains.length > 0 ? inArray(reachProspects.companyDomain, domains) : undefined,
    ...domains.map((d) => like(reachProspects.companyDomain, `%.${d.replace(/[\\%_]/g, '\\$&')}`)),
  );
}

/**
 * New suppression entries: flag the matching prospects `suppressed` and stop
 * their queued/active enrollments. Returns the campaigns that lost
 * enrollments, so the caller can complete the ones with nothing left.
 */
export async function applySuppressionsToProspects(
  db: Database,
  entries: ReadonlyArray<{ value: string; type: 'email' | 'domain' }>,
  reason: ReachSuppressionReason,
): Promise<{ campaignIds: string[] }> {
  if (entries.length === 0) return { campaignIds: [] };
  const match = prospectMatches(entries);
  const now = new Date();

  await db
    .update(reachProspects)
    .set({ validation: 'suppressed', updatedAt: now })
    .where(and(match, eq(reachProspects.validation, 'valid'), isNull(reachProspects.deletedAt)));

  const prospectIds = (
    await db.select({ id: reachProspects.id }).from(reachProspects).where(and(match, isNull(reachProspects.deletedAt)))
  ).map((p) => p.id);
  if (prospectIds.length === 0) return { campaignIds: [] };

  const stopped: Array<{ campaignId: string }> = [];
  for (let i = 0; i < prospectIds.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .update(reachEnrollments)
      .set({ status: 'unsubscribed', stoppedReason: `suppressed:${reason}`, claimedAt: null, nextSendAt: null, updatedAt: now })
      .where(
        and(
          inArray(reachEnrollments.prospectId, prospectIds.slice(i, i + LOOKUP_CHUNK)),
          inArray(reachEnrollments.status, ['queued', 'active']),
        ),
      )
      .returning({ campaignId: reachEnrollments.campaignId });
    stopped.push(...rows);
  }
  return { campaignIds: [...new Set(stopped.map((r) => r.campaignId))] };
}

/** After an entry is removed: prospects flagged `suppressed` that nothing suppresses any more become `valid` again. */
export async function releaseSuppressedProspects(
  db: Database,
  entry: { value: string; type: 'email' | 'domain' },
): Promise<void> {
  const match = prospectMatches([entry]);
  const candidates = await db
    .select({ id: reachProspects.id, email: reachProspects.email })
    .from(reachProspects)
    .where(and(match, eq(reachProspects.validation, 'suppressed')));
  if (candidates.length === 0) return;

  const index = await loadSuppressionIndex(
    db,
    candidates.map((c) => c.email),
  );
  const free = candidates.filter((c) => !index.check(c.email)).map((c) => c.id);
  for (let i = 0; i < free.length; i += LOOKUP_CHUNK) {
    await db
      .update(reachProspects)
      .set({ validation: 'valid', updatedAt: new Date() })
      .where(inArray(reachProspects.id, free.slice(i, i + LOOKUP_CHUNK)));
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ListSuppressionsQuery extends PageQuery {
  search?: string;
}

export async function listSuppressions(db: Database, q: ListSuppressionsQuery = {}): Promise<Page<ReachSuppressionDto>> {
  const limit = parseLimit(q.limit);
  const search = q.search?.trim() ? ilike(reachSuppressions.value, likePattern(q.search)) : undefined;
  const after = await cursorCondition(db, reachSuppressions, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachSuppressions)
      .where(and(search, after))
      .orderBy(desc(reachSuppressions.createdAt), desc(reachSuppressions.id))
      .limit(limit + 1),
    db.$count(reachSuppressions, search),
  ]);
  return pageResult(rows, limit, total, toSuppressionDto);
}

export interface SuppressionDeps {
  db: Database;
  /** Campaigns that run out of prospects because of a suppression are completed and announced. */
  emit: ReachEventSink;
  userId: string;
}

/**
 * Add addresses and domains by hand. The matching prospects are flagged and
 * their queued / active enrollments stop; campaigns left with nothing to send
 * are completed. No entity event for the entries themselves: the list is a
 * compliance record, not a catalogued entity.
 */
export async function addManualSuppressions(
  deps: SuppressionDeps,
  values: readonly string[],
): Promise<{ added: number; skipped: number }> {
  const { db } = deps;
  const result = await addSuppressions(db, values, { reason: 'manual', source: 'manual', createdBy: deps.userId });
  const { campaignIds } = await applySuppressionsToProspects(db, result.entries, 'manual');
  await completeAndPublishCampaigns(db, deps.emit, campaignIds);
  return { added: result.added, skipped: result.skipped };
}

/** Remove one entry; prospects it was holding back become enrollable again. */
export async function removeSuppression(db: Database, id: string): Promise<void> {
  const [row] = await db.delete(reachSuppressions).where(eq(reachSuppressions.id, id)).returning();
  if (!row) throw reachError.notFound('Suppression', id);
  await releaseSuppressedProspects(db, { value: row.value, type: row.type });
}
