/**
 * WeldReach domains: WeldHost domains connected to Mailpool through its
 * Cloudflare integration.
 *
 * Mailpool's Cloudflare token sees every zone in WeldSuite's Cloudflare
 * account, including other customers' WeldHost domains, so the domain name is
 * NEVER taken from the client: `connectDomain` resolves a `hostDomainId` in
 * THIS workspace's tenant DB and re-runs every guard server-side, whatever the
 * candidates list said earlier:
 *
 *   already_connected  a reach_domains row exists for it
 *   not_active         the WeldHost domain is not `active`
 *   not_on_cloudflare  its zone is not in WeldSuite's Cloudflare account
 *   limit_reached      `maxDomains` from the approval
 *   has_mx             existing MX records: Mailpool would overwrite the customer's email
 *   has_website        A/AAAA on the apex or www: same for the website
 *
 * Staff can allow a domain past the two DNS guards (`limits.forceAllowDomains`).
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { domainMailboxCounts, requireDomain, type DomainRow } from '@weldsuite/reach-domain/domains';
import type {
  ReachDnsStatus,
  ReachDomainCandidate,
  ReachDomainIneligibleReason,
  ReachDomainStatus,
  WeldReachLimits,
} from '@weldsuite/app-api-client/schemas/reach';
import { checkDomainFootprint, evaluateMailDns, DnsLookupError, type DnsLookup } from '../lib/dns';
import type { MailpoolClient } from '../lib/mailpool/client';
import { isMailpoolNotFound } from '../lib/mailpool/errors';
import type { MailpoolDnsRecord, MailpoolDomain } from '../lib/mailpool/types';
import { ReachServiceError } from './reach-errors';

type HostDomainRow = typeof schema.hostDomains.$inferSelect;

export interface DomainDeps {
  db: Database;
  master: MasterDatabase;
  mailpool: MailpoolClient;
  /** Clerk org id (the tenant key). */
  clerkOrgId: string;
  /** Master `workspaces.id`. */
  masterWorkspaceId: string;
  userId: string;
  limits: WeldReachLimits;
  /** DNS resolver; defaults to DNS-over-HTTPS. Injected in tests. */
  lookup?: DnsLookup;
  now?: () => Date;
}

/** What the guards and the candidates list need: no Mailpool client, no master DB. */
export type GuardDeps = Pick<DomainDeps, 'db' | 'limits' | 'lookup'>;

const nowOf = (deps: Pick<DomainDeps, 'now'>): Date => (deps.now ? deps.now() : new Date());

/** Domains DNS-checked at the same time in the candidates list. */
const DNS_CHECK_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

interface GuardContext {
  connectedHostIds: Set<string>;
  connectedCount: number;
  /** WeldHost domain ids that have a DNS zone at Cloudflare. */
  cloudflareHostIds: Set<string>;
  limits: WeldReachLimits;
  lookup?: DnsLookup;
}

async function loadGuardContext(deps: GuardDeps, hostIds: string[]): Promise<GuardContext> {
  const connected = await deps.db.select({ hostDomainId: schema.reachDomains.hostDomainId }).from(schema.reachDomains);
  const zones = hostIds.length
    ? await deps.db
        .select({ domainId: schema.hostDnsZones.domainId })
        .from(schema.hostDnsZones)
        .where(
          and(
            inArray(schema.hostDnsZones.domainId, hostIds),
            eq(schema.hostDnsZones.provider, 'cloudflare'),
            isNotNull(schema.hostDnsZones.externalZoneId),
            isNull(schema.hostDnsZones.deletedAt),
          ),
        )
    : [];
  return {
    connectedHostIds: new Set(connected.map((c) => c.hostDomainId)),
    connectedCount: connected.length,
    cloudflareHostIds: new Set(zones.map((z) => z.domainId)),
    limits: deps.limits,
    lookup: deps.lookup,
  };
}

/** The zone is in WeldSuite's Cloudflare account: a Cloudflare zone, a Cloudflare registration, or a verified WeldHost nameserver cutover. */
function isOnCloudflare(host: HostDomainRow, g: GuardContext): boolean {
  return g.cloudflareHostIds.has(host.id) || host.registrar?.toLowerCase() === 'cloudflare' || host.nameserverVerified === true;
}

function isForceAllowed(host: HostDomainRow, limits: WeldReachLimits): boolean {
  return limits.forceAllowDomains.includes(host.fullDomain.toLowerCase());
}

type DnsFailure = 'throw' | 'ignore';

/** The first guard a WeldHost domain fails, or null when it can be connected. */
async function ineligibleReason(
  host: HostDomainRow,
  g: GuardContext,
  onDnsFailure: DnsFailure,
): Promise<ReachDomainIneligibleReason | null> {
  if (g.connectedHostIds.has(host.id)) return 'already_connected';
  if (host.status !== 'active') return 'not_active';
  if (!isOnCloudflare(host, g)) return 'not_on_cloudflare';
  if (g.connectedCount >= g.limits.maxDomains) return 'limit_reached';
  if (isForceAllowed(host, g.limits)) return null;

  try {
    const footprint = await checkDomainFootprint(host.fullDomain, g.lookup);
    if (footprint.hasMx) return 'has_mx';
    if (footprint.hasWebsite) return 'has_website';
  } catch (err) {
    // The connect guard fails closed; the advisory list does not hide a domain over a resolver hiccup.
    if (onDnsFailure === 'throw' || !(err instanceof DnsLookupError)) throw err;
  }
  return null;
}

const REASON_MESSAGES: Record<ReachDomainIneligibleReason, string> = {
  already_connected: 'This domain is already connected.',
  not_active: 'This domain is not active in WeldHost yet.',
  not_on_cloudflare: 'This domain is not managed on WeldHost nameservers. Point its nameservers to WeldHost first.',
  limit_reached: 'The domain limit for this workspace is reached.',
  has_mx:
    'This domain already has email set up (MX records). Connecting it would replace that. Use a separate domain for outreach.',
  has_website:
    'This domain already serves a website. Connecting it would break the site. Use a separate domain for outreach.',
};

export function ineligibleError(reason: ReachDomainIneligibleReason): ReachServiceError {
  if (reason === 'already_connected') {
    return new ReachServiceError(409, 'DOMAIN_ALREADY_CONNECTED', REASON_MESSAGES[reason], { reason });
  }
  return new ReachServiceError(422, 'DOMAIN_NOT_ELIGIBLE', REASON_MESSAGES[reason], { reason });
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** This workspace's WeldHost domains and whether each can be connected. */
export async function listCandidates(deps: GuardDeps): Promise<ReachDomainCandidate[]> {
  const hosts = await deps.db
    .select()
    .from(schema.hostDomains)
    .where(isNull(schema.hostDomains.deletedAt))
    .orderBy(schema.hostDomains.fullDomain);
  const g = await loadGuardContext(deps, hosts.map((h) => h.id));

  const candidates: ReachDomainCandidate[] = [];
  for (let i = 0; i < hosts.length; i += DNS_CHECK_CONCURRENCY) {
    const chunk = hosts.slice(i, i + DNS_CHECK_CONCURRENCY);
    const reasons = await Promise.all(chunk.map((host) => ineligibleReason(host, g, 'ignore')));
    chunk.forEach((host, index) => {
      const reason = reasons[index] ?? null;
      candidates.push({
        hostDomainId: host.id,
        name: host.fullDomain,
        hostStatus: host.status,
        eligible: reason === null,
        reason,
      });
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function toDomainStatus(mailpoolStatus: string | undefined): ReachDomainStatus {
  return mailpoolStatus?.toLowerCase() === 'active' ? 'active' : 'connecting';
}

export async function connectDomain(deps: DomainDeps, hostDomainId: string): Promise<DomainRow> {
  const now = nowOf(deps);

  // Ownership: only a domain of THIS workspace's WeldHost, never a name from the client.
  const [host] = await deps.db
    .select()
    .from(schema.hostDomains)
    .where(and(eq(schema.hostDomains.id, hostDomainId), isNull(schema.hostDomains.deletedAt)))
    .limit(1);
  if (!host) throw new ReachServiceError(404, 'DOMAIN_NOT_FOUND', `Domain with ID '${hostDomainId}' not found`);

  const g = await loadGuardContext(deps, [host.id]);
  const reason = await ineligibleReason(host, g, 'throw');
  if (reason) throw ineligibleError(reason);

  const name = host.fullDomain.toLowerCase();
  const forced = isForceAllowed(host, deps.limits);

  const result = await deps.mailpool.connectCloudflareDomains([name]);
  const connected = result.connected.find((c) => c.domain.toLowerCase() === name);
  if (!connected) {
    const skipped = result.skipped.find((s) => (s.domain ?? s.name ?? '').toLowerCase() === name);
    const detail = skipped?.reason ? `: ${skipped.reason}` : '.';
    throw new ReachServiceError(
      422,
      'DOMAIN_CONNECT_FAILED',
      `The mailbox provider could not connect ${name}${detail}`,
      { reason: skipped?.reason ?? null },
    );
  }
  const mailpoolDomainId = String(connected.id);

  const domainId = generateId('rdom');
  let row: DomainRow | undefined;
  try {
    [row] = await deps.db
      .insert(schema.reachDomains)
      .values({
        id: domainId,
        hostDomainId: host.id,
        name,
        mailpoolDomainId,
        status: toDomainStatus(connected.status),
        forcedBy: forced ? 'admin_console' : null,
        connectedAt: now,
        connectedBy: deps.userId,
      })
      .returning();
  } catch (err) {
    await dropFromMailpool(deps, mailpoolDomainId);
    if (isUniqueViolation(err)) throw ineligibleError('already_connected');
    throw err;
  }
  if (!row) throw new Error('reach_domains insert returned no row');

  try {
    const routed = await deps.master
      .insert(masterSchema.reachRoutes)
      .values({
        id: generateId('rrt'),
        kind: 'mailpool_domain',
        externalId: mailpoolDomainId,
        workspaceId: deps.masterWorkspaceId,
        clerkOrgId: deps.clerkOrgId,
        tenantEntityId: domainId,
        status: 'active',
      })
      // Reconnecting a domain this workspace disconnected earlier reuses its route.
      .onConflictDoUpdate({
        target: [masterSchema.reachRoutes.kind, masterSchema.reachRoutes.externalId],
        set: { tenantEntityId: domainId, clerkOrgId: deps.clerkOrgId, status: 'active', updatedAt: now },
        setWhere: eq(masterSchema.reachRoutes.workspaceId, deps.masterWorkspaceId),
      })
      .returning({ id: masterSchema.reachRoutes.id });

    if (routed.length === 0) {
      // The Mailpool domain id belongs to another workspace: not ours to delete at Mailpool.
      await deps.db.delete(schema.reachDomains).where(eq(schema.reachDomains.id, domainId));
      throw new ReachServiceError(409, 'DOMAIN_IN_USE', 'This domain is connected in another workspace.');
    }
  } catch (err) {
    if (err instanceof ReachServiceError) throw err;
    await deps.db.delete(schema.reachDomains).where(eq(schema.reachDomains.id, domainId));
    await dropFromMailpool(deps, mailpoolDomainId);
    throw err;
  }

  return row;
}

/** Undo a connect at Mailpool after our own bookkeeping failed. Best effort. */
async function dropFromMailpool(deps: DomainDeps, mailpoolDomainId: string): Promise<void> {
  try {
    await deps.mailpool.deleteDomain(mailpoolDomainId);
  } catch (err) {
    console.error(`[reach-domains] rollback: could not delete Mailpool domain ${mailpoolDomainId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// DNS refresh
// ---------------------------------------------------------------------------

function dmarcPolicyOf(records: MailpoolDnsRecord[]): string | null {
  for (const record of records) {
    if (record.type !== 'TXT' || !/(^|\.)_dmarc(\.|$)/i.test(record.key ?? '')) continue;
    const match = /(?:^|;)\s*p=(none|quarantine|reject)/i.exec(record.value);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function statusFromMailpool(remote: MailpoolDomain, current: ReachDomainStatus): { status: ReachDomainStatus; lastError: string | null } {
  if (current === 'disconnecting') return { status: current, lastError: null };
  if (remote.status === 'inactive') {
    return { status: 'error', lastError: remote.error?.message ?? 'The mailbox provider disabled this domain.' };
  }
  return { status: remote.status === 'active' ? 'active' : 'connecting', lastError: null };
}

/** Re-read Mailpool's view of the domain and what a resolver returns for its mail records. */
export async function refreshDomainDns(deps: DomainDeps, id: string): Promise<DomainRow> {
  const row = await requireDomain(deps.db, id);
  if (!row.mailpoolDomainId) throw new ReachServiceError(409, 'DOMAIN_NOT_CONNECTED', 'The domain is not connected yet.');

  const [remote, records] = await Promise.all([
    deps.mailpool.getDomain(row.mailpoolDomainId),
    deps.mailpool.getDomainDns(row.mailpoolDomainId),
  ]);
  const dnsStatus: ReachDnsStatus = await evaluateMailDns({
    domain: row.name,
    expected: records,
    lookup: deps.lookup,
    now: nowOf(deps),
  });
  const { status, lastError } = statusFromMailpool(remote, row.status);

  const [updated] = await deps.db
    .update(schema.reachDomains)
    .set({
      status,
      lastError,
      dnsStatus,
      dmarcPolicy: dmarcPolicyOf(records) ?? row.dmarcPolicy,
      updatedAt: nowOf(deps),
    })
    .where(eq(schema.reachDomains.id, id))
    .returning();
  return updated ?? row;
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * Remove the domain from Mailpool and from WeldReach. Only possible once it has
 * no mailboxes left; the domain itself stays in WeldHost.
 *
 * Safe to repeat: a disconnect that stopped half way leaves the domain in
 * `disconnecting` and calling it again finishes it (Mailpool answering 404 counts as done).
 */
export async function disconnectDomain(deps: DomainDeps, id: string): Promise<DomainRow> {
  const row = await requireDomain(deps.db, id);

  const counts = await domainMailboxCounts(deps.db, [id]);
  const mailboxCount = counts.get(id) ?? 0;
  if (mailboxCount > 0) {
    throw new ReachServiceError(409, 'DOMAIN_HAS_MAILBOXES', 'Delete the mailboxes on this domain before disconnecting it.', {
      mailboxCount,
    });
  }
  const now = nowOf(deps);
  // Claim it: from here on no mailbox can be created on it.
  await deps.db.update(schema.reachDomains).set({ status: 'disconnecting', updatedAt: now }).where(eq(schema.reachDomains.id, id));

  if (row.mailpoolDomainId) {
    try {
      await deps.mailpool.deleteDomain(row.mailpoolDomainId);
    } catch (err) {
      if (!isMailpoolNotFound(err)) {
        await deps.db.update(schema.reachDomains).set({ status: row.status, updatedAt: now }).where(eq(schema.reachDomains.id, id));
        throw err;
      }
    }
    await deps.master
      .update(masterSchema.reachRoutes)
      .set({ status: 'deleted', updatedAt: now })
      .where(
        and(
          eq(masterSchema.reachRoutes.kind, 'mailpool_domain'),
          eq(masterSchema.reachRoutes.externalId, row.mailpoolDomainId),
          eq(masterSchema.reachRoutes.workspaceId, deps.masterWorkspaceId),
        ),
      );
  }

  await deps.db.delete(schema.reachDomains).where(eq(schema.reachDomains.id, id));
  return row;
}
