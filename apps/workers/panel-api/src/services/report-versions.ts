/**
 * Report version history: every change to a report's name, description or
 * spec first keeps the state it replaces as a version (`version` = the
 * report's highest + 1), in the same transaction as the change. Restoring a
 * version keeps the current state as a version too, so a restore can be
 * undone. Visibility changes are not versioned.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelReport, PanelReportVersion } from '@weldsuite/db/schema';
import type { UpdatePanelReportInput } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { panelReportSpecSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportVersionDetailDto, PanelReportVersionDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { reportChanges } from './saved-objects';

const { panelReports, panelReportVersions } = schema;

/** Versions listed per report, newest first. */
export const MAX_LISTED_VERSIONS = 100;

/** JSON with object keys sorted, so two specs compare equal whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    // Keys of one object are unique, so the order is total.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Whether the update changes what a version records (name, description or spec). */
export function changesContent(existing: PanelReport, input: UpdatePanelReportInput): boolean {
  if (input.name !== undefined && input.name !== existing.name) return true;
  if (input.description !== undefined && (input.description ?? null) !== existing.description) return true;
  return input.spec !== undefined && stableJson(input.spec) !== stableJson(existing.spec);
}

/** Inserts `report`'s current state as its next version. */
function keepVersion(handle: Database, report: PanelReport, userId: string) {
  const v = panelReportVersions;
  return handle.insert(v).values({
    id: generateId('pnrv'),
    reportId: report.id,
    version: sql`(select coalesce(max(${v.version}), 0) + 1 from ${v} where ${v.reportId} = ${report.id})`,
    name: report.name,
    description: report.description,
    spec: report.spec,
    createdByUserId: userId,
  });
}

function changeReport(handle: Database, id: string, set: Partial<typeof panelReports.$inferInsert>) {
  return handle
    .update(panelReports)
    .set(set)
    .where(and(eq(panelReports.id, id), isNull(panelReports.deletedAt)))
    .returning();
}

/**
 * Applies `input` to `existing`. When the name, description or spec changes,
 * the state before is kept as a version, atomically with the change.
 */
export async function updateReportWithHistory(
  db: Database,
  existing: PanelReport,
  input: UpdatePanelReportInput,
  userId: string,
): Promise<PanelReport | null> {
  const set = reportChanges(input);
  if (!changesContent(existing, input)) {
    const [row] = await changeReport(db, existing.id, set);
    return row ?? null;
  }
  const results = await atomically(db, (handle) => [keepVersion(handle, existing, userId), changeReport(handle, existing.id, set)]);
  const rows = results[1] as PanelReport[] | undefined;
  return rows?.[0] ?? null;
}

export function toVersionDto(v: PanelReportVersion): PanelReportVersionDto {
  return {
    id: v.id,
    reportId: v.reportId,
    version: v.version,
    name: v.name,
    description: v.description,
    kind: typeof v.spec.kind === 'string' ? v.spec.kind : 'unknown',
    createdByUserId: v.createdByUserId,
    createdAt: v.createdAt.toISOString(),
  };
}

export function toVersionDetailDto(v: PanelReportVersion): PanelReportVersionDetailDto {
  return { ...toVersionDto(v), spec: v.spec };
}

export async function listVersions(db: Database, reportId: string): Promise<PanelReportVersion[]> {
  return db
    .select()
    .from(panelReportVersions)
    .where(eq(panelReportVersions.reportId, reportId))
    .orderBy(desc(panelReportVersions.version))
    .limit(MAX_LISTED_VERSIONS);
}

export async function getVersion(db: Database, reportId: string, version: number): Promise<PanelReportVersion | null> {
  const [row] = await db
    .select()
    .from(panelReportVersions)
    .where(and(eq(panelReportVersions.reportId, reportId), eq(panelReportVersions.version, version)))
    .limit(1);
  return row ?? null;
}

export class UnrestorableVersionError extends Error {
  constructor() {
    super('This version can no longer be opened by the current report builder');
  }
}

/**
 * Puts `version` back: the current state is kept as a new version first, then
 * the name, description and spec are set from it. Throws
 * {@link UnrestorableVersionError} when its spec no longer parses.
 */
export async function restoreVersion(db: Database, report: PanelReport, version: PanelReportVersion, userId: string): Promise<PanelReport | null> {
  const parsed = panelReportSpecSchema.safeParse(version.spec);
  if (!parsed.success || parsed.data.projectId !== report.projectId) throw new UnrestorableVersionError();
  const set = reportChanges({ name: version.name, description: version.description, spec: parsed.data });
  const results = await atomically(db, (handle) => [keepVersion(handle, report, userId), changeReport(handle, report.id, set)]);
  const rows = results[1] as PanelReport[] | undefined;
  return rows?.[0] ?? null;
}
