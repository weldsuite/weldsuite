import '@tanstack/react-start/server-only';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { recordConsoleAudit } from '@/lib/audit';
import { getMasterDb, masterSchema } from '@/lib/db';
import { cleanReason, type ReportStatus } from '@/lib/weldforms';
import type { ActionResult } from './workspaces';

const links = masterSchema.formLinkRegistry;
const reports = masterSchema.formAbuseReports;

/**
 * Staff moderation of public WeldForms forms (docs/plans/weldforms.md, "Bot
 * checks and abuse"). Every action: `guardWrite()` (no read-only viewers), a
 * guarded write to the master `form_link_registry` / `form_abuse_reports` rows
 * and an admin audit row against the form's workspace.
 *
 * forms-api reads `suspended_at` and `held_at` from the registry on every
 * public request, so a suspension or release takes effect at once. The tenant
 * rows are never touched.
 */

const NOT_FOUND = 'This form has no public link.';
const REPORT_NOT_FOUND = 'This report does not exist.';
const CONFLICT = 'Someone else just changed this. Reload the page and try again.';

function isId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

async function loadLink(publicId: string) {
  const [row] = await getMasterDb().select().from(links).where(eq(links.publicId, publicId)).limit(1);
  return row ?? null;
}

async function loadReport(reportId: string) {
  const [row] = await getMasterDb().select().from(reports).where(eq(reports.id, reportId)).limit(1);
  return row ?? null;
}

type Guarded = Awaited<ReturnType<typeof guardWrite>>;
type Identity = Extract<Guarded, { ok: true }>['identity'];

/** Close an open report as `status`; false when someone else resolved it first. */
async function resolveReport(reportId: string, status: Exclude<ReportStatus, 'open'>, identity: Identity): Promise<boolean> {
  const updated = await getMasterDb()
    .update(reports)
    .set({ status, resolvedBy: identity.email, resolvedAt: new Date() })
    .where(and(eq(reports.id, reportId), eq(reports.status, 'open')))
    .returning({ id: reports.id });
  return updated.length > 0;
}

export interface FormModerationData {
  publicId: string;
}

/**
 * Suspend one published form: respondents see "no longer available". With a
 * `reportId` the report is marked actioned in the same step.
 */
export async function suspendForm(
  publicId: string,
  reason: string,
  reportId?: string,
): Promise<ActionResult<FormModerationData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const clean = cleanReason(reason);
  if (!isId(publicId, 20) || !clean || (reportId !== undefined && !isId(reportId, 30))) {
    return { ok: false, error: 'Invalid request. Give a reason of at least 3 characters.' };
  }

  const link = await loadLink(publicId);
  if (!link) return { ok: false, error: NOT_FOUND };

  const updated = await getMasterDb()
    .update(links)
    .set({ suspendedAt: new Date(), suspendedReason: clean })
    .where(and(eq(links.id, link.id), isNull(links.suspendedAt)))
    .returning({ id: links.id });
  if (updated.length === 0) return { ok: false, error: 'This form is already suspended.' };

  if (reportId) await resolveReport(reportId, 'actioned', guard.identity);

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId: link.workspaceId,
    action: 'weldforms.form.suspend',
    outcome: 'success',
    reason: clean,
    details: { publicId, formId: link.formId, reportId: reportId ?? null },
  });
  return { ok: true, data: { publicId } };
}

/** Lift a suspension: the form answers again (a held form stays held). */
export async function unsuspendForm(publicId: string, reason: string): Promise<ActionResult<FormModerationData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const clean = cleanReason(reason);
  if (!isId(publicId, 20) || !clean) return { ok: false, error: 'Invalid request. Give a reason of at least 3 characters.' };

  const link = await loadLink(publicId);
  if (!link) return { ok: false, error: NOT_FOUND };

  const updated = await getMasterDb()
    .update(links)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(and(eq(links.id, link.id), isNotNull(links.suspendedAt)))
    .returning({ id: links.id });
  if (updated.length === 0) return { ok: false, error: 'This form is not suspended.' };

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId: link.workspaceId,
    action: 'weldforms.form.unsuspend',
    outcome: 'success',
    reason: clean,
    details: { publicId, formId: link.formId, previousReason: link.suspendedReason },
  });
  return { ok: true, data: { publicId } };
}

/** Release a form the publish content screen held: it opens to respondents. */
export async function releaseHeldForm(publicId: string, reason: string): Promise<ActionResult<FormModerationData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const clean = cleanReason(reason);
  if (!isId(publicId, 20) || !clean) return { ok: false, error: 'Invalid request. Give a reason of at least 3 characters.' };

  const link = await loadLink(publicId);
  if (!link) return { ok: false, error: NOT_FOUND };

  const updated = await getMasterDb()
    .update(links)
    .set({ heldAt: null, heldReason: null })
    .where(and(eq(links.id, link.id), isNotNull(links.heldAt)))
    .returning({ id: links.id });
  if (updated.length === 0) return { ok: false, error: 'This form is not held.' };

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId: link.workspaceId,
    action: 'weldforms.form.release',
    outcome: 'success',
    reason: clean,
    details: { publicId, formId: link.formId, heldReason: link.heldReason },
  });
  return { ok: true, data: { publicId } };
}

async function closeReport(
  status: Exclude<ReportStatus, 'open'>,
  reportId: string,
  reason: string,
): Promise<ActionResult<{ id: string; status: ReportStatus }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const clean = cleanReason(reason);
  if (!isId(reportId, 30) || !clean) return { ok: false, error: 'Invalid request. Give a reason of at least 3 characters.' };

  const report = await loadReport(reportId);
  if (!report) return { ok: false, error: REPORT_NOT_FOUND };
  if (report.status !== 'open') return { ok: false, error: CONFLICT };
  if (!(await resolveReport(reportId, status, guard.identity))) return { ok: false, error: CONFLICT };

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId: report.workspaceId,
    action: `weldforms.report.${status === 'dismissed' ? 'dismiss' : 'action'}`,
    outcome: 'success',
    reason: clean,
    details: { reportId, publicId: report.publicId, formId: report.formId, reportReason: report.reason },
  });
  return { ok: true, data: { id: reportId, status } };
}

/** Close a report as not a problem. */
export async function dismissReport(reportId: string, reason: string) {
  return closeReport('dismissed', reportId, reason);
}

/** Close a report as dealt with (the form was suspended, the workspace warned, ...). */
export async function markReportActioned(reportId: string, reason: string) {
  return closeReport('actioned', reportId, reason);
}

/**
 * Suspend every public form of a workspace that is not suspended already:
 * the answer to a workspace that is abusing the module.
 */
export async function suspendWorkspaceForms(
  workspaceId: string,
  reason: string,
): Promise<ActionResult<{ workspaceId: string; suspended: number }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const clean = cleanReason(reason);
  if (!isId(workspaceId, 255) || !clean) return { ok: false, error: 'Invalid request. Give a reason of at least 3 characters.' };

  const updated = await getMasterDb()
    .update(links)
    .set({ suspendedAt: new Date(), suspendedReason: clean })
    .where(and(eq(links.workspaceId, workspaceId), isNull(links.suspendedAt)))
    .returning({ publicId: links.publicId });
  if (updated.length === 0) return { ok: false, error: 'This workspace has no public forms that are not suspended.' };

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId,
    action: 'weldforms.workspace.suspend_forms',
    outcome: 'success',
    reason: clean,
    details: { count: updated.length, publicIds: updated.map((r) => r.publicId).slice(0, 100) },
  });
  return { ok: true, data: { workspaceId, suspended: updated.length } };
}
