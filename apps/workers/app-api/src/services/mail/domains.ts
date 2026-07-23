/**
 * Mail domain service.
 *
 * `mail_domains` tracks per-workspace domains that can receive (and now
 * send) mail. Provisioning a domain flips Cloudflare Email Routing on
 * the customer zone, registers the apex with Email Sending so the
 * `[[send_email]]` binding accepts `MAIL FROM:<*@domain>`, and points
 * the catch-all rule at the mail-inbound worker.
 *
 * The Cloudflare calls are idempotent on CF's side, so we can re-assert
 * routing on `verify` / `sync` to self-heal half-provisioned rows.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import * as cfEmail from '../../lib/cloudflare-email';

const { mailDomains } = schema;

export class MailDomainError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'DUPLICATE_DOMAIN'
      | 'CLOUDFLARE_PROVISION_FAILED'
      | 'CLOUDFLARE_VERIFY_FAILED',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MailDomainError';
  }
}

export interface ListDomainsFilters {
  isActive?: boolean;
  isPrimary?: boolean;
}

export async function listDomains(db: Database, filters: ListDomainsFilters) {
  const conditions: SQL[] = [isNull(mailDomains.deletedAt)!];
  if (filters.isActive !== undefined) conditions.push(eq(mailDomains.isActive, filters.isActive));
  if (filters.isPrimary !== undefined) conditions.push(eq(mailDomains.isPrimary, filters.isPrimary));
  return db
    .select()
    .from(mailDomains)
    .where(and(...conditions))
    .orderBy(desc(mailDomains.isPrimary), asc(mailDomains.domainName));
}

export async function getDomain(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.id, id), isNull(mailDomains.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getDomainByName(db: Database, domainName: string) {
  const [row] = await db
    .select()
    .from(mailDomains)
    .where(
      and(eq(mailDomains.domainName, domainName.toLowerCase()), isNull(mailDomains.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

export interface DomainInput {
  domainName: string;
  isActive?: boolean;
  isPrimary?: boolean;
  mailProvider?: string;
  sendProvider?: string;
  receiveProvider?: string;
  maxEmailAccounts?: number;
}

/**
 * Create a `mail_domains` row and provision Cloudflare Email Routing +
 * Email Sending on the zone. If CF provisioning fails we don't insert
 * the row — half-provisioned domains are worse than absent ones.
 */
export async function createDomain(env: Env, db: Database, data: DomainInput) {
  const normalized = data.domainName.toLowerCase().trim();
  const existing = await getDomainByName(db, normalized);
  if (existing) {
    throw new MailDomainError('DUPLICATE_DOMAIN', `Domain ${normalized} is already registered`);
  }

  // Provision before insert. Cloudflare's API is idempotent so a retry
  // after a transient failure won't double-create the routing rule.
  try {
    await cfEmail.createDomain(env, normalized);
  } catch (err) {
    throw new MailDomainError(
      'CLOUDFLARE_PROVISION_FAILED',
      `Couldn't enable Cloudflare Email Routing on ${normalized}. ` +
        `Check that the domain's nameservers are on Cloudflare and the zone is active.`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const id = generateId('mdom');
  const now = new Date();
  await db.insert(mailDomains).values({
    id,
    domainName: normalized,
    isActive: data.isActive ?? true,
    isPrimary: data.isPrimary ?? false,
    mailProvider: data.mailProvider ?? 'cloudflare',
    sendProvider: data.sendProvider ?? 'cloudflare',
    receiveProvider: data.receiveProvider ?? 'cloudflare',
    dnsStatus: 'verified',
    cloudflareRoutingEnabled: true,
    maxEmailAccounts: data.maxEmailAccounts ?? 100,
    currentEmailAccounts: 0,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Promoting to primary unsets any other primary in the same workspace.
  if (data.isPrimary) await markAsSolePrimary(db, id);

  const [row] = await db.select().from(mailDomains).where(eq(mailDomains.id, id));
  return row!;
}

export async function updateDomain(db: Database, id: string, data: Partial<DomainInput>) {
  const [existing] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.id, id), isNull(mailDomains.deletedAt)))
    .limit(1);
  if (!existing) throw new MailDomainError('NOT_FOUND', 'Domain not found');

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined && k !== 'domainName') patch[k] = v;
  await db
    .update(mailDomains)
    .set(patch as typeof mailDomains.$inferInsert)
    .where(eq(mailDomains.id, id));

  if (data.isPrimary) await markAsSolePrimary(db, id);

  const [after] = await db.select().from(mailDomains).where(eq(mailDomains.id, id));
  return { before: existing, after: after! };
}

/**
 * Soft-delete the row and deprovision Cloudflare Email Routing on the
 * zone (best-effort — a CF failure shouldn't block the user from removing
 * the domain locally; they can re-deprovision via /verify later).
 */
export async function softDeleteDomain(env: Env, db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.id, id), isNull(mailDomains.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await db
    .update(mailDomains)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailDomains.id, id));

  try {
    await cfEmail.deleteDomain(env, existing.domainName);
  } catch (err) {
    console.error(
      `[mail-domains] Cloudflare deprovision failed for ${existing.domainName}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return existing;
}

/**
 * Re-query Cloudflare for the current routing state and persist the
 * verification timestamp + spf/dmarc booleans. Idempotent — safe to call
 * from the UI on a "Check now" button.
 */
export async function verifyDomain(env: Env, db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.id, id), isNull(mailDomains.deletedAt)))
    .limit(1);
  if (!existing) throw new MailDomainError('NOT_FOUND', 'Domain not found');

  let verifyResult: Record<string, unknown>;
  try {
    verifyResult = await cfEmail.getDomain(env, existing.domainName);
  } catch (err) {
    throw new MailDomainError(
      'CLOUDFLARE_VERIFY_FAILED',
      `Couldn't verify ${existing.domainName} with Cloudflare`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const verified = (verifyResult.verified as boolean) ?? false;
  const records = (verifyResult.records as unknown[]) ?? [];
  const now = new Date();

  await db
    .update(mailDomains)
    .set({
      dnsStatus: verified ? 'verified' : 'pending',
      dnsRecords: records as never,
      cloudflareRoutingEnabled: verified,
      verifiedAt: verified ? now : existing.verifiedAt,
      lastVerificationAttempt: now,
      updatedAt: now,
    })
    .where(eq(mailDomains.id, id));

  const [after] = await db.select().from(mailDomains).where(eq(mailDomains.id, id));
  return { verified, after: after! };
}

/**
 * Re-assert Cloudflare provisioning on the zone. Same call as creating,
 * but kept as an explicit endpoint so the UI can offer a "re-sync"
 * button when state drifts (manual MX edits, zone moved between accounts).
 */
export async function syncDomain(env: Env, db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailDomains)
    .where(and(eq(mailDomains.id, id), isNull(mailDomains.deletedAt)))
    .limit(1);
  if (!existing) throw new MailDomainError('NOT_FOUND', 'Domain not found');

  try {
    await cfEmail.createDomain(env, existing.domainName);
  } catch (err) {
    throw new MailDomainError(
      'CLOUDFLARE_PROVISION_FAILED',
      `Couldn't re-sync ${existing.domainName} with Cloudflare`,
      err instanceof Error ? err.message : String(err),
    );
  }

  await db
    .update(mailDomains)
    .set({
      cloudflareRoutingEnabled: true,
      dnsStatus: 'verified',
      lastVerificationAttempt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailDomains.id, id));

  const [after] = await db.select().from(mailDomains).where(eq(mailDomains.id, id));
  return after!;
}

/**
 * Generate DKIM record metadata. Under Cloudflare Email Routing this is
 * a no-op — Cloudflare publishes ARC-DKIM automatically — but the route
 * is preserved so legacy clients keep working.
 */
export async function generateDkim(env: Env, db: Database, id: string) {
  const existing = await getDomain(db, id);
  if (!existing) throw new MailDomainError('NOT_FOUND', 'Domain not found');

  // Always returns a stub for Cloudflare-managed zones — the DKIM record
  // is auto-published. We persist the selector so the UI can show
  // something deterministic in the DNS instructions panel.
  await db
    .update(mailDomains)
    .set({
      dkimSelector: 'cf',
      dkimVerified: true,
      updatedAt: new Date(),
    })
    .where(eq(mailDomains.id, id));

  return { selector: 'cf', dnsRecord: '', provider: 'cloudflare' as const };
}

async function markAsSolePrimary(db: Database, id: string) {
  await db
    .update(mailDomains)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(and(isNull(mailDomains.deletedAt), sql`${mailDomains.id} != ${id}`));
}
