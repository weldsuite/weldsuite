import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { loadPlatformStatus } from '@/lib/mail-api';
import { readFilters } from '@/lib/outbound-mail';
import {
  CASE_LIST_LIMIT,
  WORKSPACE_TABLE_LIMIT,
  countCasesByStatus,
  countPoliciesByState,
  getCase,
  listCases,
  listPlatformEvents,
  listRiskWorkspaces,
} from '@/lib/outbound-mail-data';

export type OutboundMailSearchParams = Record<string, string | string[] | undefined>;

/** The platform breaker, workspaces by risk and the cases matching the filters in the search params. */
export async function loadOutboundMailPage(searchParams: OutboundMailSearchParams) {
  const identity = await requireAdmin();
  const filters = readFilters(searchParams);
  const canWrite = identity.role !== 'viewer';

  const [platform, platformEvents, workspaces, stateCounts, cases, caseCounts, linked] = await Promise.all([
    loadPlatformStatus(identity),
    listPlatformEvents(1),
    listRiskWorkspaces(filters.state),
    countPoliciesByState(),
    listCases(filters),
    countCasesByStatus(),
    filters.caseId ? getCase(filters.caseId) : Promise.resolve(null),
  ]);

  return {
    filters,
    canWrite,
    platform,
    platformEvents,
    workspaces,
    stateCounts,
    cases,
    caseCounts,
    linked,
    workspaceTableLimit: WORKSPACE_TABLE_LIMIT,
    caseListLimit: CASE_LIST_LIMIT,
  };
}

export type OutboundMailPageData = NonNullable<Awaited<ReturnType<typeof loadOutboundMailPage>>>;
