/**
 * Custom collector domains: a project's own host name (`stats.example.com`)
 * served by panel-ingest through Cloudflare for SaaS, so ad blockers that know
 * the shared collector host do not drop the site's events.
 *
 * Rows live in the master `panel_custom_domains` (host names are unique across
 * workspaces, and the cron polls pending ones without opening tenant DBs).
 * Cloudflare calls go through `@weldsuite/cloudflare-zones/custom-hostnames`.
 *
 * Off unless `PANEL_SAAS_ZONE_ID` (the SaaS zone, whose fallback origin is
 * panel-ingest), `PANEL_SAAS_CNAME_TARGET` (what customers CNAME to) and
 * `CLOUDFLARE_API_TOKEN` are all set: the routes then answer 503.
 *
 * Status: `pending` until Cloudflare reports the host name and its
 * certificate active, then `active`; `failed` when Cloudflare gives up
 * (blocked, moved, validation timed out); `deleting` while its removal at
 * Cloudflare is being retried.
 */

import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostname,
  type CustomHostnameState,
} from '@weldsuite/cloudflare-zones/custom-hostnames';
import { installSnippet } from '@weldsuite/panel-sdk/install';
import type { PanelCustomDomain, PanelDomainStatus, PanelDomainVerificationRecord } from '@weldsuite/db/schema/master';
import type { PanelDomainDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { Env } from '../types';

const { panelCustomDomains } = masterSchema;

/** Most custom host names one project may have. */
export const MAX_DOMAINS_PER_PROJECT = 5;

export interface SaasConfig {
  zoneId: string;
  cnameTarget: string;
  apiToken: string;
}

/** The Cloudflare for SaaS setup, or null when this environment has none. */
export function saasConfig(env: Pick<Env, 'PANEL_SAAS_ZONE_ID' | 'PANEL_SAAS_CNAME_TARGET' | 'CLOUDFLARE_API_TOKEN'>): SaasConfig | null {
  const zoneId = env.PANEL_SAAS_ZONE_ID?.trim();
  const cnameTarget = env.PANEL_SAAS_CNAME_TARGET?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!zoneId || !cnameTarget || !apiToken) return null;
  return { zoneId, cnameTarget, apiToken };
}

const FAILED_HOSTNAME = new Set(['moved', 'blocked', 'pending_blocked', 'deleted', 'pending_deletion', 'test_blocked', 'test_failed']);

/** Our status from Cloudflare's host name and certificate status. */
export function domainStatusOf(state: Pick<CustomHostnameState, 'status' | 'sslStatus'>): PanelDomainStatus {
  if (FAILED_HOSTNAME.has(state.status)) return 'failed';
  const ssl = state.sslStatus ?? '';
  if (ssl.endsWith('timed_out') || ssl === 'expired' || ssl === 'deleted') return 'failed';
  if (state.status === 'active' && ssl === 'active') return 'active';
  return 'pending';
}

/** The DNS records the customer adds: the CNAME always, the TXT records Cloudflare asks for. */
export function verificationRecords(hostname: string, cnameTarget: string, state: CustomHostnameState | null): PanelDomainVerificationRecord[] {
  const records: PanelDomainVerificationRecord[] = [{ type: 'CNAME', name: hostname, value: cnameTarget, purpose: 'routing' }];
  if (state?.ownership) records.push({ type: 'TXT', name: state.ownership.name, value: state.ownership.value, purpose: 'ownership' });
  for (const r of state?.certificateRecords ?? []) records.push({ type: 'TXT', name: r.name, value: r.value, purpose: 'certificate' });
  return records;
}

export function domainScriptUrl(hostname: string): string {
  return `https://${hostname}/s.js`;
}

/** A domain as the API shows it; the install snippet (for the project's token) once it is active. */
export function toDomainDto(d: PanelCustomDomain, projectToken: string | null): PanelDomainDto {
  const active = d.status === 'active';
  return {
    id: d.id,
    projectId: d.projectId,
    hostname: d.hostname,
    status: d.status,
    sslStatus: d.sslStatus,
    records: d.verification.map((r) => ({ ...r })),
    lastError: d.lastError,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    scriptUrl: active ? domainScriptUrl(d.hostname) : null,
    snippet: active && projectToken ? installSnippet(projectToken, `https://${d.hostname}`) : null,
    createdAt: d.createdAt.toISOString(),
  };
}

export function domainEventData(d: PanelCustomDomain) {
  return { id: d.id, projectId: d.projectId, hostname: d.hostname, status: d.status };
}

export async function listDomains(masterDb: AnyMasterDatabase, workspaceId: string, projectId: string): Promise<PanelCustomDomain[]> {
  return masterDb
    .select()
    .from(panelCustomDomains)
    .where(and(eq(panelCustomDomains.workspaceId, workspaceId), eq(panelCustomDomains.projectId, projectId), isNull(panelCustomDomains.deletedAt)))
    .orderBy(asc(panelCustomDomains.createdAt));
}

export async function getDomain(masterDb: AnyMasterDatabase, workspaceId: string, projectId: string, id: string): Promise<PanelCustomDomain | null> {
  const [row] = await masterDb
    .select()
    .from(panelCustomDomains)
    .where(
      and(
        eq(panelCustomDomains.id, id),
        eq(panelCustomDomains.workspaceId, workspaceId),
        eq(panelCustomDomains.projectId, projectId),
        isNull(panelCustomDomains.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

function stateFields(cfg: SaasConfig, hostname: string, state: CustomHostnameState, now: Date) {
  return {
    cfCustomHostnameId: state.id,
    status: domainStatusOf(state),
    sslStatus: state.sslStatus,
    verification: verificationRecords(hostname, cfg.cnameTarget, state),
    lastError: state.errors.length > 0 ? state.errors.join('; ').slice(0, 500) : null,
    lastCheckedAt: now,
    updatedAt: now,
  };
}

export type CreateDomainResult = { ok: true; domain: PanelCustomDomain } | { ok: false; reason: 'taken' | 'limit' | 'cloudflare'; message: string };

/**
 * Claims the host name (the unique index decides a race), then registers it
 * at Cloudflare. When Cloudflare refuses, the claim is released.
 */
export async function createDomain(
  masterDb: AnyMasterDatabase,
  cfg: SaasConfig,
  input: { workspaceId: string; projectId: string; hostname: string; userId: string },
  now = new Date(),
): Promise<CreateDomainResult> {
  const existing = await listDomains(masterDb, input.workspaceId, input.projectId);
  if (existing.length >= MAX_DOMAINS_PER_PROJECT) return { ok: false, reason: 'limit', message: `A project can have at most ${MAX_DOMAINS_PER_PROJECT} custom domains` };

  const id = generateId('pncd');
  const claimed = await masterDb
    .insert(panelCustomDomains)
    .values({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      hostname: input.hostname,
      status: 'pending',
      verification: verificationRecords(input.hostname, cfg.cnameTarget, null),
      createdByUserId: input.userId,
    })
    .onConflictDoNothing({ target: panelCustomDomains.hostname })
    .returning();
  if (claimed.length === 0) return { ok: false, reason: 'taken', message: 'This host name is already in use' };

  let state: CustomHostnameState;
  try {
    state = await createCustomHostname(cfg.apiToken, cfg.zoneId, input.hostname, { workspace_id: input.workspaceId, project_id: input.projectId, domain_id: id });
  } catch (err) {
    await masterDb.delete(panelCustomDomains).where(eq(panelCustomDomains.id, id));
    return { ok: false, reason: 'cloudflare', message: errorText(err) };
  }
  const [row] = await masterDb.update(panelCustomDomains).set(stateFields(cfg, input.hostname, state, now)).where(eq(panelCustomDomains.id, id)).returning();
  return { ok: true, domain: row as PanelCustomDomain };
}

/** Asks Cloudflare for the host name's state and stores it. A Cloudflare error is stored, not thrown. */
export async function refreshDomain(masterDb: AnyMasterDatabase, cfg: SaasConfig, domain: PanelCustomDomain, now = new Date()): Promise<PanelCustomDomain> {
  if (!domain.cfCustomHostnameId) return domain;
  let set: Partial<typeof panelCustomDomains.$inferInsert>;
  try {
    const state = await getCustomHostname(cfg.apiToken, cfg.zoneId, domain.cfCustomHostnameId);
    set = state
      ? stateFields(cfg, domain.hostname, state, now)
      : { status: 'failed', lastError: 'Cloudflare no longer has this host name', lastCheckedAt: now, updatedAt: now };
  } catch (err) {
    set = { lastError: errorText(err), lastCheckedAt: now, updatedAt: now };
  }
  const [row] = await masterDb.update(panelCustomDomains).set(set).where(eq(panelCustomDomains.id, domain.id)).returning();
  return row ?? domain;
}

/**
 * Removes the host name at Cloudflare, then the row (so the name can be
 * claimed again). When Cloudflare fails, the row stays `deleting` with the
 * error and the cron retries.
 */
export async function removeDomain(masterDb: AnyMasterDatabase, cfg: SaasConfig, domain: PanelCustomDomain, now = new Date()): Promise<{ removed: boolean; domain: PanelCustomDomain }> {
  try {
    if (domain.cfCustomHostnameId) await deleteCustomHostname(cfg.apiToken, cfg.zoneId, domain.cfCustomHostnameId);
  } catch (err) {
    const [row] = await masterDb
      .update(panelCustomDomains)
      .set({ status: 'deleting', lastError: errorText(err), lastCheckedAt: now, updatedAt: now })
      .where(eq(panelCustomDomains.id, domain.id))
      .returning();
    return { removed: false, domain: row ?? domain };
  }
  await masterDb.delete(panelCustomDomains).where(eq(panelCustomDomains.id, domain.id));
  return { removed: true, domain: { ...domain, status: 'deleting' } };
}

/** Domains every workspace's cron pass looks at: pending ones and removals to retry, least recently checked first. */
export async function domainsToPoll(masterDb: AnyMasterDatabase, now: Date, limit: number): Promise<PanelCustomDomain[]> {
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  return masterDb
    .select()
    .from(panelCustomDomains)
    .where(
      and(
        inArray(panelCustomDomains.status, ['pending', 'deleting']),
        isNull(panelCustomDomains.deletedAt),
        or(isNull(panelCustomDomains.lastCheckedAt), lt(panelCustomDomains.lastCheckedAt, staleBefore)),
      ),
    )
    .orderBy(asc(panelCustomDomains.lastCheckedAt))
    .limit(limit);
}
