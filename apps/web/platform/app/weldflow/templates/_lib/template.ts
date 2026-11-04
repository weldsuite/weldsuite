/**
 * Pure helpers of the Templates page: weeks from working-day offsets, the
 * summary of what a template creates, the Create project form (schema,
 * defaults, the end date the server will compute, the request body).
 */

import { z } from 'zod';
import {
  DEFAULT_WORKING_DAYS,
  PROJECT_MANAGER_ROLE,
  addWorkingDays,
  instantiateTemplateSchema,
  type Blueprint,
  type InstantiateCopy,
  type InstantiateTemplateInput,
} from '@weldsuite/app-api-client/schemas/project-closing';

/** A working week, as the gallery and the preview count weeks. */
export const WORKING_DAYS_PER_WEEK = 5;

/** The length of a template in weeks: 5 working days a week, rounded up. */
export function templateWeeks(durationDays: number): number {
  return Math.ceil(Math.max(0, durationDays) / WORKING_DAYS_PER_WEEK);
}

/** The week (from 1) a working-day offset falls in; offset 0 is the first day of week 1. */
export function weekOf(offset: number): number {
  return Math.floor(Math.max(0, offset) / WORKING_DAYS_PER_WEEK) + 1;
}

export interface PhaseSummary {
  key: string;
  name: string;
  /** Null when the phase has no dates. */
  fromWeek: number | null;
  toWeek: number | null;
  /** Tasks whose due offset falls in the phase. */
  tasks: number;
  criteria: number;
}

export function phaseSummaries(blueprint: Blueprint): PhaseSummary[] {
  return blueprint.phases.map((phase) => {
    const start = phase.startOffset ?? null;
    const end = phase.endOffset ?? null;
    const dated = start !== null || end !== null;
    const tasks = blueprint.tasks.filter((task) => {
      const due = task.dueOffset ?? null;
      if (!dated || due === null) return false;
      return (start === null || due >= start) && (end === null || due <= end);
    }).length;
    return {
      key: phase.key,
      name: phase.name,
      fromWeek: start === null ? (end === null ? null : weekOf(end)) : weekOf(start),
      toWeek: end === null ? (start === null ? null : weekOf(start)) : weekOf(end),
      tasks,
      criteria: phase.gateCriteria.length,
    };
  });
}

// ── Dates ───────────────────────────────────────────────────────────────────

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/** `YYYY-MM-DD` for a UTC midnight date. */
export function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` value as a UTC midnight date; null when it is not a real calendar date. */
export function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || toDateInput(date) !== value ? null : date;
}

/** The working days of a template's calendar (Monday to Friday unless it says otherwise). */
export function workingDaysOf(blueprint: Blueprint): readonly number[] {
  return blueprint.settings.schedule?.workingDays ?? DEFAULT_WORKING_DAYS;
}

/** The start a new project gets: the next working day after today. */
export function defaultStartDate(today: Date, workingDays?: readonly number[]): string {
  return toDateInput(addWorkingDays(utcDay(today), 1, workingDays));
}

/** The end date the server will compute for a start, on the template's calendar; null for an invalid start. */
export function endDateOf(start: string, blueprint: Blueprint): Date | null {
  const date = parseDateInput(start);
  return date ? addWorkingDays(date, blueprint.durationDays, workingDaysOf(blueprint)) : null;
}

// ── The Create project form ─────────────────────────────────────────────────

export const COPY_KEYS = ['phases', 'milestones', 'deliverables', 'tasks', 'stages', 'raid', 'changeControl', 'statusReport'] as const;
export type CopyKey = (typeof COPY_KEYS)[number];

/** How many things each copy option brings, when the blueprint says; undefined for the settings. */
export function copyCounts(blueprint: Blueprint): Record<CopyKey, number | undefined> {
  return {
    phases: blueprint.phases.length,
    milestones: blueprint.milestones.length,
    deliverables: blueprint.deliverables.length,
    tasks: blueprint.tasks.length,
    stages: blueprint.stages.length,
    raid: blueprint.raid.length,
    changeControl: undefined,
    statusReport: undefined,
  };
}

const shape = instantiateTemplateSchema.shape;

const dateInput = z.string().refine((value) => parseDateInput(value) !== null, { params: { code: 'invalidDate' } });

export const createProjectFormSchema = z.object({
  name: shape.name,
  client: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
  startDate: dateInput,
  roles: z.record(z.string().nullable()),
  copy: z.object({
    phases: z.boolean(),
    milestones: z.boolean(),
    deliverables: z.boolean(),
    tasks: z.boolean(),
    stages: z.boolean(),
    raid: z.boolean(),
    changeControl: z.boolean(),
    statusReport: z.boolean(),
  }),
});
export type CreateProjectFormValues = z.infer<typeof createProjectFormSchema>;

/** Every role empty, except the project manager, who is the signed-in person. */
export function defaultRoles(blueprint: Blueprint, userId: string | null): Record<string, string | null> {
  return Object.fromEntries(blueprint.roles.map((role) => [role.key, role.key === PROJECT_MANAGER_ROLE ? userId : null]));
}

export function defaultCopy(): Required<InstantiateCopy> {
  return { phases: true, milestones: true, deliverables: true, tasks: true, stages: true, raid: true, changeControl: true, statusReport: true };
}

/** The request body of a form, checked against the shared schema the API validates with; null when it fails. */
export function buildInstantiateBody(values: CreateProjectFormValues): InstantiateTemplateInput | null {
  const roles = Object.fromEntries(Object.entries(values.roles).filter((entry): entry is [string, string] => entry[1] !== null));
  const parsed = instantiateTemplateSchema.safeParse({
    name: values.name,
    startDate: values.startDate,
    clientId: values.client?.id ?? null,
    roles,
    copy: values.copy,
  });
  return parsed.success ? parsed.data : null;
}
