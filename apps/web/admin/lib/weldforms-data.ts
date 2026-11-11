import '@tanstack/react-start/server-only';

import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import { DEFAULT_PORTAL_URL, REPORT_STATUSES, publicFormUrl, type ReportFilter, type ReportStatus } from './weldforms';

const reports = masterSchema.formAbuseReports;
const links = masterSchema.formLinkRegistry;
const workspaces = masterSchema.workspaces;

/** Rows each table shows; the page says when there may be more. */
export const REPORT_LIST_LIMIT = 200;
export const FORM_LIST_LIMIT = 200;

export function formsPortalUrl(): string {
  return process.env.FORMS_PORTAL_URL?.trim() || DEFAULT_PORTAL_URL;
}

export interface ReportRow {
  id: string;
  publicId: string;
  publicUrl: string;
  workspaceId: string;
  workspaceName: string | null;
  formId: string;
  reason: string;
  details: string | null;
  reporterEmail: string | null;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** The form's current state in the registry. */
  suspendedAt: string | null;
  heldAt: string | null;
  /** False when the registry no longer has the link (the form was unpublished for good). */
  linkExists: boolean;
}

export interface FormLinkRow {
  id: string;
  publicId: string;
  publicUrl: string;
  workspaceId: string;
  workspaceName: string | null;
  formId: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  heldAt: string | null;
  heldReason: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Abuse reports with the workspace name and the form's current registry state, newest first. */
export async function listReports(filter: ReportFilter): Promise<ReportRow[]> {
  const portal = formsPortalUrl();
  const rows = await getMasterDb()
    .select({
      id: reports.id,
      publicId: reports.publicId,
      workspaceId: reports.workspaceId,
      workspaceName: workspaces.name,
      formId: reports.formId,
      reason: reports.reason,
      details: reports.details,
      reporterEmail: reports.reporterEmail,
      status: reports.status,
      resolvedBy: reports.resolvedBy,
      resolvedAt: reports.resolvedAt,
      createdAt: reports.createdAt,
      linkId: links.id,
      suspendedAt: links.suspendedAt,
      heldAt: links.heldAt,
    })
    .from(reports)
    .leftJoin(workspaces, eq(workspaces.id, reports.workspaceId))
    .leftJoin(links, eq(links.publicId, reports.publicId))
    .where(filter === 'all' ? undefined : eq(reports.status, filter))
    .orderBy(desc(reports.createdAt))
    .limit(REPORT_LIST_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    publicId: r.publicId,
    publicUrl: publicFormUrl(portal, r.publicId),
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    formId: r.formId,
    reason: r.reason,
    details: r.details,
    reporterEmail: r.reporterEmail,
    status: r.status,
    resolvedBy: r.resolvedBy,
    resolvedAt: iso(r.resolvedAt),
    createdAt: r.createdAt.toISOString(),
    suspendedAt: iso(r.suspendedAt),
    heldAt: iso(r.heldAt),
    linkExists: r.linkId !== null,
  }));
}

export async function countReportsByStatus(): Promise<Record<ReportStatus, number>> {
  const rows = await getMasterDb()
    .select({ status: reports.status, n: sql<number>`count(*)::int` })
    .from(reports)
    .groupBy(reports.status);
  const counts = Object.fromEntries(REPORT_STATUSES.map((s) => [s, 0])) as Record<ReportStatus, number>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

async function listLinks(where: SQL | undefined, order: typeof links.heldAt | typeof links.suspendedAt): Promise<FormLinkRow[]> {
  const portal = formsPortalUrl();
  const rows = await getMasterDb()
    .select({
      id: links.id,
      publicId: links.publicId,
      workspaceId: links.workspaceId,
      workspaceName: workspaces.name,
      formId: links.formId,
      suspendedAt: links.suspendedAt,
      suspendedReason: links.suspendedReason,
      heldAt: links.heldAt,
      heldReason: links.heldReason,
    })
    .from(links)
    .leftJoin(workspaces, eq(workspaces.id, links.workspaceId))
    .where(where)
    .orderBy(desc(order))
    .limit(FORM_LIST_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    publicId: r.publicId,
    publicUrl: publicFormUrl(portal, r.publicId),
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    formId: r.formId,
    suspendedAt: iso(r.suspendedAt),
    suspendedReason: r.suspendedReason,
    heldAt: iso(r.heldAt),
    heldReason: r.heldReason,
  }));
}

/** Forms the publish content screen held for review (and not suspended since). */
export function listHeldForms(): Promise<FormLinkRow[]> {
  return listLinks(and(isNotNull(links.heldAt), isNull(links.suspendedAt)), links.heldAt);
}

/** Forms staff suspended. */
export function listSuspendedForms(): Promise<FormLinkRow[]> {
  return listLinks(isNotNull(links.suspendedAt), links.suspendedAt);
}
