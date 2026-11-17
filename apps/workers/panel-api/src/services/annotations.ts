/**
 * Chart annotations: a label pinned to a moment, on every time chart of a
 * project (`reportId` null) or on one report. Annotations are the project's
 * (no visibility of their own); one on a report is seen only by those who may
 * see that report. Changing or deleting is for the author, or for
 * `panel_projects:manage`.
 */

import { and, asc, eq, gte, isNull, lte, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelAnnotation } from '@weldsuite/db/schema';
import type {
  CreatePanelAnnotationInput,
  PanelAnnotationDto,
  UpdatePanelAnnotationInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';

const { panelAnnotations } = schema;

/** Annotations listed per request. */
export const MAX_LISTED_ANNOTATIONS = 1000;

export function toAnnotationDto(a: PanelAnnotation): PanelAnnotationDto {
  return {
    id: a.id,
    projectId: a.projectId,
    reportId: a.reportId,
    occurredAt: a.occurredAt.toISOString(),
    label: a.label,
    description: a.description,
    createdByUserId: a.createdByUserId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_annotation` event: id, project, report, date and label. */
export function annotationEventData(a: PanelAnnotation) {
  return { id: a.id, projectId: a.projectId, reportId: a.reportId, occurredAt: a.occurredAt.toISOString(), label: a.label };
}

/** A day (`YYYY-MM-DD`, UTC) or an ISO moment as a Date: a day's start for `from`, its end for `to`. */
export function boundary(value: string, edge: 'from' | 'to'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);
  return new Date(value);
}

/** The project-wide annotations, plus `reportId`'s own when given, in time order. */
export async function listAnnotations(
  db: Database,
  params: { projectId: string; from?: string; to?: string; reportId?: string },
): Promise<PanelAnnotation[]> {
  const conds: SQL[] = [eq(panelAnnotations.projectId, params.projectId), isNull(panelAnnotations.deletedAt)];
  const scope = params.reportId
    ? or(isNull(panelAnnotations.reportId), eq(panelAnnotations.reportId, params.reportId))
    : isNull(panelAnnotations.reportId);
  if (scope) conds.push(scope);
  if (params.from) conds.push(gte(panelAnnotations.occurredAt, boundary(params.from, 'from')));
  if (params.to) conds.push(lte(panelAnnotations.occurredAt, boundary(params.to, 'to')));
  return db
    .select()
    .from(panelAnnotations)
    .where(and(...conds))
    .orderBy(asc(panelAnnotations.occurredAt), asc(panelAnnotations.id))
    .limit(MAX_LISTED_ANNOTATIONS);
}

export async function getAnnotation(db: Database, id: string): Promise<PanelAnnotation | null> {
  const [row] = await db
    .select()
    .from(panelAnnotations)
    .where(and(eq(panelAnnotations.id, id), isNull(panelAnnotations.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createAnnotation(db: Database, input: CreatePanelAnnotationInput, userId: string): Promise<PanelAnnotation> {
  const [row] = await db
    .insert(panelAnnotations)
    .values({
      id: generateId('pnan'),
      projectId: input.projectId,
      reportId: input.reportId ?? null,
      occurredAt: new Date(input.occurredAt),
      label: input.label,
      description: input.description ?? null,
      createdByUserId: userId,
    })
    .returning();
  return row as PanelAnnotation;
}

export async function updateAnnotation(db: Database, id: string, input: UpdatePanelAnnotationInput): Promise<PanelAnnotation | null> {
  const [row] = await db
    .update(panelAnnotations)
    .set({
      ...(input.reportId !== undefined && { reportId: input.reportId }),
      ...(input.occurredAt !== undefined && { occurredAt: new Date(input.occurredAt) }),
      ...(input.label !== undefined && { label: input.label }),
      ...(input.description !== undefined && { description: input.description }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelAnnotations.id, id), isNull(panelAnnotations.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteAnnotation(db: Database, id: string): Promise<PanelAnnotation | null> {
  const [row] = await db
    .update(panelAnnotations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelAnnotations.id, id), isNull(panelAnnotations.deletedAt)))
    .returning();
  return row ?? null;
}
