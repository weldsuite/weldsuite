import 'server-only';

import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import {
  DEFAULT_POLICY,
  OUTBOUND_CASE_STATUSES,
  OUTBOUND_STATES,
  caseMetrics,
  cleanLimitOverrides,
  computedTrustFromWorkspace,
  isCaseSeverity,
  isCaseStatus,
  isCaseTrigger,
  isOutboundState,
  isTrustLevel,
  trustDisplay,
  type CaseVerdictView,
  type MetricItem,
  type OutboundCaseSeverity,
  type OutboundCaseStatus,
  type OutboundCaseTrigger,
  type OutboundState,
  type OutboundTrustLevel,
  type PolicySnapshot,
  type TrustDisplay,
} from './outbound-mail';

const { outboundMailPolicies: policies, outboundMailCases: cases, outboundMailEvents: events, workspaces, plans } = masterSchema;

/**
 * Read side of the Outbound mail screens (docs/plans/weldmail-outbound-abuse.md,
 * "Staff tooling"). Policies, cases and their trail live in the master DB; the
 * mail-api ledger writes them automatically, staff through
 * `actions/outbound-mail.ts`.
 *
 * A case's `snippet` is customer mail content: no query here selects it. The
 * screens only learn whether there is one, and `revealOutboundSnippet` reads it
 * after recording an audit row.
 */

export const WORKSPACE_TABLE_LIMIT = 200;
export const CASE_LIST_LIMIT = 100;
const EVENT_LIST_LIMIT = 100;
const WORKSPACE_CASE_LIMIT = 50;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

const openCaseCount = sql<number>`(
  select count(*)::int from ${cases}
  where ${cases.workspaceId} = ${policies.workspaceId}
    and ${cases.status} = 'open'
)`;

// ---------------------------------------------------------------------------
// Workspaces ranked by risk
// ---------------------------------------------------------------------------

export interface RiskWorkspaceRow {
  workspaceId: string;
  /** Null when the workspace row is gone (the policy outlived it). */
  name: string | null;
  slug: string | null;
  planName: string | null;
  createdAt: string | null;
  deleted: boolean;
  trust: TrustDisplay;
  state: OutboundState;
  stateReason: string | null;
  stateSetBy: string | null;
  stateSetAt: string | null;
  riskScore: number;
  riskUpdatedAt: string | null;
  updatedAt: string;
  openCases: number;
}

/** Workspaces with a policy row, riskiest first. A workspace without a row has the defaults and a score of 0. */
export async function listRiskWorkspaces(
  state: OutboundState | 'all',
): Promise<{ rows: RiskWorkspaceRow[]; total: number }> {
  const db = getMasterDb();
  const conditions: SQL[] = [isNotNull(policies.workspaceId)];
  if (state !== 'all') conditions.push(eq(policies.state, state));
  const where = and(...conditions);

  const [rows, [count]] = await Promise.all([
    db
      .select({
        workspaceId: policies.workspaceId,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
        deletedAt: workspaces.deletedAt,
        subscriptionStatus: workspaces.subscriptionStatus,
        compGrantedAt: workspaces.compGrantedAt,
        billingMode: workspaces.billingMode,
        planName: plans.name,
        planPriceMonthly: plans.priceMonthly,
        trustOverride: policies.trustOverride,
        state: policies.state,
        stateReason: policies.stateReason,
        stateSetBy: policies.stateSetBy,
        stateSetAt: policies.stateSetAt,
        riskScore: policies.riskScore,
        riskUpdatedAt: policies.riskUpdatedAt,
        updatedAt: policies.updatedAt,
        openCases: openCaseCount,
      })
      .from(policies)
      .leftJoin(workspaces, eq(workspaces.id, policies.workspaceId))
      .leftJoin(plans, eq(plans.id, workspaces.planId))
      .where(where)
      .orderBy(desc(policies.riskScore), desc(policies.updatedAt))
      .limit(WORKSPACE_TABLE_LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(policies).where(where),
  ]);

  const now = new Date();
  return {
    total: Number(count?.n ?? 0),
    rows: rows.map((row) => {
      const computed: OutboundTrustLevel = row.createdAt
        ? computedTrustFromWorkspace(
            {
              createdAt: row.createdAt,
              subscriptionStatus: row.subscriptionStatus,
              planPriceMonthly: row.planPriceMonthly,
              compGrantedAt: row.compGrantedAt,
              billingMode: row.billingMode,
            },
            now,
          )
        : 'new';
      return {
        workspaceId: row.workspaceId ?? '',
        name: row.name,
        slug: row.slug,
        planName: row.planName,
        createdAt: iso(row.createdAt),
        deleted: Boolean(row.deletedAt) || row.name === null,
        trust: trustDisplay(row.trustOverride, computed),
        state: isOutboundState(row.state) ? row.state : 'active',
        stateReason: row.stateReason,
        stateSetBy: row.stateSetBy,
        stateSetAt: iso(row.stateSetAt),
        riskScore: Number(row.riskScore),
        riskUpdatedAt: iso(row.riskUpdatedAt),
        updatedAt: row.updatedAt.toISOString(),
        openCases: Number(row.openCases ?? 0),
      };
    }),
  };
}

/** Workspace policies per state, for the filter tabs. */
export async function countPoliciesByState(): Promise<Record<OutboundState, number>> {
  const rows = await getMasterDb()
    .select({ state: policies.state, n: sql<number>`count(*)::int` })
    .from(policies)
    .where(isNotNull(policies.workspaceId))
    .groupBy(policies.state);
  const counts = Object.fromEntries(OUTBOUND_STATES.map((s) => [s, 0])) as Record<OutboundState, number>;
  for (const row of rows) if (isOutboundState(row.state)) counts[row.state] = Number(row.n);
  return counts;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CaseRow {
  id: string;
  workspaceId: string | null;
  personalAccountId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  /** One of OUTBOUND_CASE_TRIGGERS when `triggerKnown`; kept as stored otherwise. */
  trigger: string;
  triggerKnown: boolean;
  severity: OutboundCaseSeverity;
  fingerprint: string | null;
  verdict: CaseVerdictView | null;
  riskScore: number | null;
  /** Whether there is a snippet to reveal; the text itself is never loaded here. */
  hasSnippet: boolean;
  subject: string | null;
  sampleDomains: string[];
  sources: string[];
  summary: string | null;
  metrics: MetricItem[];
  status: OutboundCaseStatus;
  alertedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

/** Every case column except the snippet. */
const caseColumns = {
  id: cases.id,
  workspaceId: cases.workspaceId,
  personalAccountId: cases.personalAccountId,
  workspaceName: workspaces.name,
  workspaceSlug: workspaces.slug,
  trigger: cases.trigger,
  severity: cases.severity,
  fingerprint: cases.fingerprint,
  aiVerdict: cases.aiVerdict,
  riskScore: cases.riskScore,
  hasSnippet: sql<boolean>`(${cases.snippet} is not null and length(${cases.snippet}) > 0)`,
  subject: cases.subject,
  sampleDomains: cases.sampleDomains,
  sources: cases.sources,
  metrics: cases.metrics,
  status: cases.status,
  alertedAt: cases.alertedAt,
  reviewedBy: cases.reviewedBy,
  reviewedAt: cases.reviewedAt,
  reviewNotes: cases.reviewNotes,
  createdAt: cases.createdAt,
};

type CaseQueryRow = {
  id: string;
  workspaceId: string | null;
  personalAccountId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  trigger: string;
  severity: string;
  fingerprint: string | null;
  aiVerdict: typeof cases.$inferSelect.aiVerdict;
  riskScore: number | null;
  hasSnippet: boolean;
  subject: string | null;
  sampleDomains: unknown;
  sources: unknown;
  metrics: unknown;
  status: string;
  alertedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function toVerdict(raw: CaseQueryRow['aiVerdict']): CaseVerdictView | null {
  if (!raw || typeof raw !== 'object' || typeof raw.category !== 'string') return null;
  return {
    category: raw.category,
    unsolicited: raw.unsolicited === true,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    signals: strings(raw.signals),
    modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
  };
}

function toCaseRow(row: CaseQueryRow): CaseRow {
  const { summary, items } = caseMetrics(row.metrics);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    personalAccountId: row.personalAccountId,
    workspaceName: row.workspaceName,
    workspaceSlug: row.workspaceSlug,
    trigger: row.trigger,
    triggerKnown: isCaseTrigger(row.trigger),
    severity: isCaseSeverity(row.severity) ? row.severity : 'info',
    fingerprint: row.fingerprint,
    verdict: toVerdict(row.aiVerdict),
    riskScore: row.riskScore,
    hasSnippet: row.hasSnippet === true,
    subject: row.subject,
    sampleDomains: strings(row.sampleDomains),
    sources: strings(row.sources),
    summary,
    metrics: items,
    status: isCaseStatus(row.status) ? row.status : 'open',
    alertedAt: iso(row.alertedAt),
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    reviewNotes: row.reviewNotes,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CaseFilters {
  status: OutboundCaseStatus | 'all';
  trigger: OutboundCaseTrigger | 'all';
  severity: OutboundCaseSeverity | 'all';
  workspaceId?: string;
}

/** Cases, newest first. */
export async function listCases(filters: CaseFilters, limit: number = CASE_LIST_LIMIT): Promise<CaseRow[]> {
  const conditions: SQL[] = [];
  if (filters.status !== 'all') conditions.push(eq(cases.status, filters.status));
  if (filters.trigger !== 'all') conditions.push(eq(cases.trigger, filters.trigger));
  if (filters.severity !== 'all') conditions.push(eq(cases.severity, filters.severity));
  if (filters.workspaceId) conditions.push(eq(cases.workspaceId, filters.workspaceId));

  const rows = await getMasterDb()
    .select(caseColumns)
    .from(cases)
    .leftJoin(workspaces, eq(workspaces.id, cases.workspaceId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(cases.createdAt))
    .limit(limit);
  return rows.map(toCaseRow);
}

/** A workspace's cases, every status, newest first. */
export function listWorkspaceCases(workspaceId: string): Promise<CaseRow[]> {
  return listCases({ status: 'all', trigger: 'all', severity: 'all', workspaceId }, WORKSPACE_CASE_LIMIT);
}

/** One case (the `?case=` deep link from an alert email). */
export async function getCase(caseId: string): Promise<CaseRow | null> {
  const [row] = await getMasterDb()
    .select(caseColumns)
    .from(cases)
    .leftJoin(workspaces, eq(workspaces.id, cases.workspaceId))
    .where(eq(cases.id, caseId))
    .limit(1);
  return row ? toCaseRow(row) : null;
}

export async function countCasesByStatus(): Promise<Record<OutboundCaseStatus, number>> {
  const rows = await getMasterDb()
    .select({ status: cases.status, n: sql<number>`count(*)::int` })
    .from(cases)
    .groupBy(cases.status);
  const counts = Object.fromEntries(OUTBOUND_CASE_STATUSES.map((s) => [s, 0])) as Record<OutboundCaseStatus, number>;
  for (const row of rows) if (isCaseStatus(row.status)) counts[row.status] = Number(row.n);
  return counts;
}

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

export interface OutboundWorkspace {
  id: string;
  name: string;
  slug: string;
  planName: string | null;
  createdAt: string;
  deleted: boolean;
  /** From age and plan alone; see `computedTrustFromWorkspace`. */
  computedTrust: OutboundTrustLevel;
}

export interface OutboundPolicyDetail extends PolicySnapshot {
  id: string;
  stateSetBy: string | null;
  stateSetAt: string | null;
  riskScore: number;
  riskUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The workspace and its policy row (null when it has none, which means the defaults). */
export async function getOutboundWorkspace(
  workspaceId: string,
): Promise<{ workspace: OutboundWorkspace; policy: OutboundPolicyDetail | null } | null> {
  const db = getMasterDb();
  const [[workspace], [policy]] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
        deletedAt: workspaces.deletedAt,
        subscriptionStatus: workspaces.subscriptionStatus,
        compGrantedAt: workspaces.compGrantedAt,
        billingMode: workspaces.billingMode,
        planName: plans.name,
        planPriceMonthly: plans.priceMonthly,
      })
      .from(workspaces)
      .leftJoin(plans, eq(plans.id, workspaces.planId))
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
    db.select().from(policies).where(eq(policies.workspaceId, workspaceId)).limit(1),
  ]);
  if (!workspace) return null;

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      planName: workspace.planName,
      createdAt: workspace.createdAt.toISOString(),
      deleted: Boolean(workspace.deletedAt),
      computedTrust: computedTrustFromWorkspace(workspace),
    },
    policy: policy
      ? {
          id: policy.id,
          trustOverride: isTrustLevel(policy.trustOverride) ? policy.trustOverride : null,
          limits: cleanLimitOverrides(policy.limits),
          state: isOutboundState(policy.state) ? policy.state : DEFAULT_POLICY.state,
          stateReason: policy.stateReason,
          allowRepliesWhenSuspended: policy.allowRepliesWhenSuspended,
          notes: policy.notes,
          stateSetBy: policy.stateSetBy,
          stateSetAt: iso(policy.stateSetAt),
          riskScore: policy.riskScore,
          riskUpdatedAt: iso(policy.riskUpdatedAt),
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
        }
      : null,
  };
}

/** For the link on the workspace screen: the state, the stored risk and the open cases. */
export async function getOutboundSummary(
  workspaceId: string,
): Promise<{ state: OutboundState; riskScore: number; openCases: number }> {
  const db = getMasterDb();
  const [[policy], [open]] = await Promise.all([
    db
      .select({ state: policies.state, riskScore: policies.riskScore })
      .from(policies)
      .where(eq(policies.workspaceId, workspaceId))
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.workspaceId, workspaceId), eq(cases.status, 'open'))),
  ]);
  const state = policy?.state;
  return {
    state: isOutboundState(state) ? state : 'active',
    riskScore: Number(policy?.riskScore ?? 0),
    openCases: Number(open?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

export interface OutboundEventRow {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  reason: string | null;
  actor: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

const eventColumns = {
  id: events.id,
  kind: events.kind,
  fromValue: events.fromValue,
  toValue: events.toValue,
  reason: events.reason,
  actor: events.actor,
  details: events.details,
  createdAt: events.createdAt,
};

function toEventRow(row: {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  reason: string | null;
  actor: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): OutboundEventRow {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** A workspace's trail of state, trust, limit and case changes, newest first. */
export async function listWorkspaceEvents(workspaceId: string): Promise<OutboundEventRow[]> {
  const rows = await getMasterDb()
    .select(eventColumns)
    .from(events)
    .where(eq(events.workspaceId, workspaceId))
    .orderBy(desc(events.createdAt))
    .limit(EVENT_LIST_LIMIT);
  return rows.map(toEventRow);
}

/** Platform breaker events (no workspace, no personal account), newest first. */
export async function listPlatformEvents(limit = 5): Promise<OutboundEventRow[]> {
  const rows = await getMasterDb()
    .select(eventColumns)
    .from(events)
    .where(and(isNull(events.workspaceId), isNull(events.personalAccountId), eq(events.kind, 'platform_breaker')))
    .orderBy(desc(events.createdAt))
    .limit(limit);
  return rows.map(toEventRow);
}
