/**
 * WeldFlow closing and templates (slice F of the project-management build):
 * lessons learned (`/api/project-lessons`), closing a project
 * (`/api/project-close`) and project templates (`/api/project-templates`).
 *
 * Request schemas, the shapes the routes answer, and the one piece of pure
 * logic the UI shares with the server: counting working days, so the Create
 * project form can show the end date the server will compute. Design:
 * weldsuite-documentation `design/modules/weldflow-delivery-and-portfolio.md`
 * ("Close a project", "Create from a template"), ADR FLOW-021.
 *
 * Request bodies are `.strict()`: a field the API does not accept is a 400 and
 * never silently dropped.
 */

import { z } from 'zod';

// ── Building blocks ─────────────────────────────────────────────────────────

const identifier = z.string().min(1).max(255);
/** `YYYY-MM-DD`, a real calendar date. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'Use a date as YYYY-MM-DD');

// ── Working days ────────────────────────────────────────────────────────────

/** ISO weekdays that are working days by default: Monday to Friday (1 = Monday ... 7 = Sunday). */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

const DAY_MS = 86_400_000;

/** The ISO weekday (1 = Monday ... 7 = Sunday) of a UTC day number. */
function isoWeekday(dayNumber: number): number {
  // Day 0 is 1970-01-01, a Thursday (4).
  return ((((dayNumber + 3) % 7) + 7) % 7) + 1;
}

/** The UTC day number (days since 1970-01-01) of an instant. */
export function dayNumberOf(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

/** Midnight UTC of a day number. */
export function dateOfDayNumber(dayNumber: number): Date {
  return new Date(dayNumber * DAY_MS);
}

/**
 * The ISO weekdays (1-7) to count. Anything else is dropped, and a calendar left
 * with no working day falls back to Monday to Friday, so the day walks below
 * always end (the Rust twin does the same).
 */
function workingSet(workingDays: readonly number[] | undefined): ReadonlySet<number> {
  const days = (workingDays ?? []).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return new Set(days.length > 0 ? days : DEFAULT_WORKING_DAYS);
}

/** The first working day on or after the day. */
function rollForward(dayNumber: number, working: ReadonlySet<number>): number {
  let day = dayNumber;
  while (!working.has(isoWeekday(day))) day += 1;
  return day;
}

/** The last working day on or before the day. */
function rollBack(dayNumber: number, working: ReadonlySet<number>): number {
  let day = dayNumber;
  while (!working.has(isoWeekday(day))) day -= 1;
  return day;
}

/**
 * The date `offset` working days after `start`. Offset 0 is the start itself
 * when it is a working day, else the next one; a negative offset counts back.
 * The result is midnight UTC.
 */
export function addWorkingDays(start: Date, offset: number, workingDays?: readonly number[]): Date {
  const working = workingSet(workingDays);
  let day = rollForward(dayNumberOf(start), working);
  let remaining = Math.trunc(offset);
  const step = remaining < 0 ? -1 : 1;
  while (remaining !== 0) {
    day += step;
    if (working.has(isoWeekday(day))) remaining -= step;
  }
  return dateOfDayNumber(day);
}

/**
 * How many working days after `start` a date falls: the inverse of
 * {@link addWorkingDays} (negative when the date is before the start). A date
 * on a non-working day counts as the working day before it.
 */
export function workingDayOffset(start: Date, date: Date, workingDays?: readonly number[]): number {
  const working = workingSet(workingDays);
  const from = rollForward(dayNumberOf(start), working);
  const to = dayNumberOf(date);
  if (to >= from) {
    let count = 0;
    for (let day = from + 1; day <= to; day += 1) if (working.has(isoWeekday(day))) count += 1;
    return count;
  }
  let count = 0;
  const target = rollBack(to, working);
  for (let day = from - 1; day >= target; day -= 1) if (working.has(isoWeekday(day))) count -= 1;
  return count;
}

// ── Lessons learned ─────────────────────────────────────────────────────────

export const LESSON_CATEGORIES = ['went_well', 'went_badly', 'do_differently'] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

export const LESSON_TEXT_MAX = 2_000;

const lessonText = z.string().trim().min(1).max(LESSON_TEXT_MAX);

/** `POST /api/project-lessons`. */
export const createLessonSchema = z
  .object({
    projectId: identifier,
    category: z.enum(LESSON_CATEGORIES),
    text: lessonText,
  })
  .strict();
export type CreateLessonInput = z.infer<typeof createLessonSchema>;

/** `PATCH /api/project-lessons/:id`. */
export const updateLessonSchema = z
  .object({
    category: z.enum(LESSON_CATEGORIES).optional(),
    text: lessonText.optional(),
  })
  .strict();
export type UpdateLessonInput = z.infer<typeof updateLessonSchema>;

/** Languages a published page is written in. */
export const LESSON_PAGE_LOCALES = ['en', 'nl'] as const;
export type LessonPageLocale = (typeof LESSON_PAGE_LOCALES)[number];

/** `POST /api/project-lessons/publish`: one WeldKnow page with every lesson of the project. */
export const publishLessonsSchema = z
  .object({
    projectId: identifier,
    spaceId: identifier,
    /** Defaults to "Lessons learned: <project name>". */
    title: z.string().trim().min(1).max(500).optional(),
    /** The language of the page's headings. Default `en`. */
    locale: z.enum(LESSON_PAGE_LOCALES).optional(),
  })
  .strict();
export type PublishLessonsInput = z.infer<typeof publishLessonsSchema>;

/** A lesson as the routes answer it. `votes` are counted; the voters are not listed. */
export const lessonSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  category: z.enum(LESSON_CATEGORIES),
  text: z.string(),
  authorId: z.string(),
  voteCount: z.number().int(),
  votedByMe: z.boolean(),
  knowPageId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lesson = z.infer<typeof lessonSchema>;

export const publishLessonsResultSchema = z.object({
  pageId: z.string(),
  spaceId: z.string(),
  title: z.string(),
  lessonCount: z.number().int(),
});
export type PublishLessonsResult = z.infer<typeof publishLessonsResultSchema>;

// ── Closing ─────────────────────────────────────────────────────────────────

/** The checks of the close checklist, in the order the page lists them. */
export const CLOSE_CHECK_KEYS = ['deliverables', 'changes', 'raid', 'benefits', 'time', 'lessons', 'signoff'] as const;
export type CloseCheckKey = (typeof CLOSE_CHECK_KEYS)[number];

/** One handed-over object: the item and who takes it over. */
export const handoverEntrySchema = z.object({ id: identifier, ownerId: identifier }).strict();

/** `POST /api/project-close/:projectId/handover`: open RAID items and benefits get a new owner. */
export const handoverSchema = z
  .object({
    raidItems: z.array(handoverEntrySchema).max(200).optional(),
    benefits: z.array(handoverEntrySchema).max(200).optional(),
  })
  .strict();
export type HandoverInput = z.infer<typeof handoverSchema>;

/** `POST /api/project-close/:projectId/request`: ask the sponsor to sign off. */
export const requestCloseSchema = z.object({ note: z.string().trim().max(2_000).nullish() }).strict();
export type RequestCloseInput = z.infer<typeof requestCloseSchema>;

export type CloseCheckState = 'done' | 'open' | 'waiting';

export interface CloseCheck {
  key: CloseCheckKey;
  /** A blocking check has to be done before sign-off can be requested. */
  blocking: boolean;
  done: boolean;
  state: CloseCheckState;
  /** How many objects the check is about (deliverables, items, entries ...); 0 when it does not count. */
  total: number;
  /** How many of them are in order. */
  satisfied: number;
}

export interface CloseDeliverable {
  id: string;
  code: string;
  title: string;
  status: string;
  acceptedAt: string | null;
}

export interface CloseRaidItem {
  id: string;
  kind: string;
  code: string;
  title: string;
  status: string;
  ownerId: string | null;
  /** The owner took the item over on the close page. */
  handedOver: boolean;
}

export interface CloseBenefit {
  id: string;
  code: string;
  title: string;
  status: string;
  ownerId: string | null;
  unit: string | null;
  baselineValue: string | null;
  targetValue: string | null;
  realiseBy: string | null;
  /** The latest monthly measurement, if any. */
  latest: { period: string; value: string; measuredAt: string } | null;
}

export interface CloseFinance {
  currency: string | null;
  /** False when the caller may see percentages only (no `projects:finance`, not a manager). */
  amountsVisible: boolean;
  /** The budget on the latest baseline, else the project's budgeted amount. */
  budget: string | null;
  /** Cost of the approved and billed time entries. */
  timeCost: string | null;
  /** The latest weekly finance snapshot, if one was written. */
  snapshot: { week: string; actualCost: string; committed: string; forecast: string | null } | null;
  /** The snapshot's actual cost when there is a snapshot, else `timeCost`. */
  actual: string | null;
  variance: string | null;
  /** Variance as a percentage of the budget; null without a budget. */
  variancePercent: number | null;
  overBudget: boolean;
  baseline: { version: number; goLive: string | null } | null;
}

export interface CloseSignOff {
  state: 'none' | 'pending' | 'approved' | 'rejected';
  sponsorId: string | null;
  approval: {
    id: string;
    approverId: string;
    decision: string;
    note: string | null;
    decidedAt: string | null;
    decidedBy: string | null;
    delegatedFrom: string | null;
    requestedAt: string;
  } | null;
}

/** `GET /api/project-close/:projectId`: the checklist, computed from the project's tables. */
export interface CloseChecklist {
  projectId: string;
  projectName: string;
  status: string;
  closed: boolean;
  /** The date the project closed (`actualEndDate`), when it is closed. */
  closedAt: string | null;
  checks: CloseCheck[];
  progress: { done: number; total: number };
  /** Every blocking check is done and the project is not closed: sign-off can be requested. */
  canRequest: boolean;
  deliverables: CloseDeliverable[];
  raidItems: CloseRaidItem[];
  benefits: CloseBenefit[];
  time: { total: number; approved: number; billed: number; open: number };
  finance: CloseFinance;
  lessons: { total: number; published: number };
  signOff: CloseSignOff;
}

// ── Templates ───────────────────────────────────────────────────────────────

/** The blueprint layout this code writes and reads (FLOW-021: versioned, upgraded when read). */
export const BLUEPRINT_VERSION = 1;

/** A local key: how the items of one blueprint refer to each other. */
const localKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, digits and underscores');

const optionalKey = localKey.nullish();
const offset = z.number().int().min(-3_650).max(36_500);
const offsetOrNull = offset.nullish();

/** The role keys the code gives meaning to. */
export const PROJECT_MANAGER_ROLE = 'project_manager';
export const SPONSOR_ROLE = 'sponsor';

export const BLUEPRINT_MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type BlueprintMemberRole = (typeof BLUEPRINT_MEMBER_ROLES)[number];

const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;
const SYSTEM_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done', 'cancelled'] as const;
const DEPENDENCY_TYPES = ['fs', 'ss', 'ff', 'sf'] as const;

/** A person of the source project, as the role they play. */
export const blueprintRoleSchema = z
  .object({
    key: localKey,
    label: z.string().trim().min(1).max(100),
    /** How a person in this role joins the project; null: not a project member. */
    projectRole: z.enum(BLUEPRINT_MEMBER_ROLES).nullable(),
  })
  .strict();

export const blueprintStageSchema = z
  .object({
    key: localKey,
    name: z.string().trim().min(1).max(255),
    color: z.string().max(50).nullable(),
    systemStatus: z.enum(SYSTEM_STATUSES),
  })
  .strict();

/** One gate criterion: a catalogue key with its parameters, or a manual criterion (text). */
export const blueprintGateCriterionSchema = z.union([
  z.object({ key: z.string().min(1).max(100), params: z.record(z.unknown()).optional() }).strict(),
  z.object({ manual: z.string().trim().min(1).max(1_000) }).strict(),
]);

export const blueprintPhaseSchema = z
  .object({
    key: localKey,
    name: z.string().trim().min(1).max(255),
    startOffset: offsetOrNull,
    endOffset: offsetOrNull,
    gateCriteria: z.array(blueprintGateCriterionSchema).max(50),
  })
  .strict();

export const blueprintMilestoneSchema = z
  .object({
    key: localKey,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).nullable(),
    offset,
    isKey: z.boolean(),
    ownerRole: optionalKey,
  })
  .strict();

export const blueprintDeliverableSchema = z
  .object({
    key: localKey,
    title: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).nullable(),
    ownerRole: optionalKey,
    startOffset: offsetOrNull,
    endOffset: offsetOrNull,
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).max(50),
    clientVisible: z.boolean(),
  })
  .strict();

export const blueprintTaskSchema = z
  .object({
    key: localKey,
    parentKey: optionalKey,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).nullable(),
    priority: z.enum(TASK_PRIORITIES),
    type: z.string().trim().min(1).max(50),
    /** Where the task starts in the new project's board: the backlog or the to-do column. */
    status: z.enum(['backlog', 'todo']),
    assigneeRoles: z.array(localKey).max(20),
    startOffset: offsetOrNull,
    dueOffset: offsetOrNull,
    /** Decimal string, as the column stores it. */
    estimatedHours: z.string().max(20).nullable(),
    storyPoints: z.number().int().min(0).max(1_000).nullable(),
    milestoneKey: optionalKey,
    deliverableKey: optionalKey,
    labels: z.array(z.string().max(100)).max(50).nullable(),
    tags: z.array(z.string().max(100)).max(50).nullable(),
    isBillable: z.boolean(),
  })
  .strict();

export const blueprintDependencySchema = z
  .object({
    predecessor: localKey,
    successor: localKey,
    type: z.enum(DEPENDENCY_TYPES),
    lagDays: z.number().int().min(-3_650).max(3_650),
  })
  .strict();

const RAID_KINDS = ['risk', 'assumption', 'issue', 'dependency'] as const;
const rating = z.number().int().min(1).max(5);

/** An open register item that starts the new project's log. Fields of another kind stay null. */
export const blueprintRaidItemSchema = z
  .object({
    kind: z.enum(RAID_KINDS),
    title: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).nullable(),
    category: z.string().max(100).nullable(),
    ownerRole: optionalKey,
    probability: rating.nullable(),
    impact: rating.nullable(),
    strategy: z.enum(['avoid', 'mitigate', 'transfer', 'accept']).nullable(),
    trigger: z.string().max(2_000).nullable(),
    costImpact: z.string().max(30).nullable(),
    scheduleImpactDays: z.number().int().min(0).max(3_650).nullable(),
    reviewIntervalDays: z.number().int().min(1).max(365).nullable(),
    confidence: z.enum(['low', 'medium', 'high']).nullable(),
    ifWrong: z.string().max(10_000).nullable(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
    direction: z.enum(['inbound', 'outbound']).nullable(),
    partyType: z.enum(['project', 'supplier', 'team', 'customer']).nullable(),
    partyName: z.string().max(255).nullable(),
  })
  .strict()
  .superRefine((item, ctx) => {
    // A risk is rated; the columns of another kind stay empty (the table's check constraints).
    const fieldsOf: Record<(typeof RAID_KINDS)[number], readonly (keyof typeof item)[]> = {
      risk: ['probability', 'impact', 'strategy', 'trigger', 'costImpact', 'scheduleImpactDays', 'reviewIntervalDays'],
      assumption: ['confidence', 'ifWrong'],
      issue: ['severity'],
      dependency: ['direction', 'partyType', 'partyName'],
    };
    if (item.kind === 'risk' && (item.probability === null || item.impact === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A risk needs a probability and an impact', path: ['probability'] });
    }
    for (const [kind, fields] of Object.entries(fieldsOf)) {
      if (kind === item.kind) continue;
      for (const field of fields) {
        if (item[field] !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} does not apply to a ${item.kind}`, path: [field] });
        }
      }
    }
  });

export const blueprintSettingsSchema = z
  .object({
    schedule: z
      .object({
        workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        autoSchedule: z.boolean(),
      })
      .strict()
      .optional(),
    changeControl: z
      .object({
        costLimit: z.number().min(0),
        scheduleLimitDays: z.number().min(0),
        /** Roles of the change board (people become roles). */
        boardRoles: z.array(localKey).max(50),
      })
      .strict()
      .optional(),
    statusReport: z
      .object({
        cadence: z.enum(['weekly', 'biweekly', 'monthly']),
        weekday: z.number().int().min(1).max(7),
        hour: z.number().int().min(0).max(23),
        recipientsRule: z.enum(['sponsor', 'all_stakeholders', 'portal_contacts']),
      })
      .strict()
      .optional(),
    communicationPlan: z
      .array(
        z
          .object({
            what: z.string().max(500),
            audience: z.string().max(500),
            cadence: z.string().max(200),
            channel: z.string().max(200),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    riskAppetite: z.number().int().min(1).max(25).optional(),
  })
  .strict();

/** What a new project takes over from the source project (FLOW-021). */
export const blueprintProjectSchema = z
  .object({
    type: z.string().max(50).nullable(),
    methodology: z.string().max(50).nullable(),
    priority: z.string().max(50).nullable(),
    visibility: z.string().max(50).nullable(),
    color: z.string().max(50).nullable(),
    icon: z.string().max(255).nullable(),
    budgetCurrency: z.string().max(10).nullable(),
    billingMethod: z.string().max(50).nullable(),
    isBillable: z.boolean(),
    trackTime: z.boolean(),
  })
  .strict();

/**
 * Blueprint version 1: tasks with dependencies, milestones, phases with gate
 * criteria, deliverables, open RAID items, pipeline stages and the control and
 * reporting settings. Dates are offsets in working days from the project
 * start, people are roles, ids are local keys.
 */
export const blueprintV1Schema = z
  .object({
    version: z.literal(1),
    /** Working days from the start to the end of the project. */
    durationDays: z.number().int().min(0).max(36_500),
    roles: z.array(blueprintRoleSchema).max(100),
    project: blueprintProjectSchema,
    stages: z.array(blueprintStageSchema).max(50),
    phases: z.array(blueprintPhaseSchema).max(100),
    milestones: z.array(blueprintMilestoneSchema).max(500),
    deliverables: z.array(blueprintDeliverableSchema).max(500),
    tasks: z.array(blueprintTaskSchema).max(5_000),
    dependencies: z.array(blueprintDependencySchema).max(20_000),
    raid: z.array(blueprintRaidItemSchema).max(500),
    settings: blueprintSettingsSchema,
  })
  .strict();
export type BlueprintV1 = z.infer<typeof blueprintV1Schema>;

/** Every version a stored blueprint may have; older ones are upgraded when read. */
export const blueprintSchema = blueprintV1Schema;
export type Blueprint = z.infer<typeof blueprintSchema>;

/** What a template amounts to, for the gallery. */
export interface BlueprintSummary {
  durationDays: number;
  tasks: number;
  milestones: number;
  phases: number;
  deliverables: number;
  raidItems: number;
  stages: number;
  roles: number;
}

/** `POST /api/project-templates`: a template from a blueprint in the body. */
export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2_000).nullish(),
    blueprint: blueprintSchema,
    shared: z.boolean().optional(),
  })
  .strict();
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/** `PATCH /api/project-templates/:id`. */
export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2_000).nullish(),
    blueprint: blueprintSchema.optional(),
    shared: z.boolean().optional(),
  })
  .strict();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

/** `POST /api/project-templates/from-project/:projectId`. `roleLabels` names the roles the builder found. */
export const templateFromProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2_000).nullish(),
    shared: z.boolean().optional(),
    roleLabels: z.record(z.string().trim().min(1).max(100)).optional(),
  })
  .strict();
export type TemplateFromProjectInput = z.infer<typeof templateFromProjectSchema>;

/** What to copy from the template. Everything is copied unless turned off. */
export const instantiateCopySchema = z
  .object({
    phases: z.boolean().optional(),
    milestones: z.boolean().optional(),
    deliverables: z.boolean().optional(),
    tasks: z.boolean().optional(),
    stages: z.boolean().optional(),
    raid: z.boolean().optional(),
    changeControl: z.boolean().optional(),
    statusReport: z.boolean().optional(),
  })
  .strict();
export type InstantiateCopy = z.infer<typeof instantiateCopySchema>;

/** `POST /api/project-templates/:id/instantiate`. */
export const instantiateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    /** The project's start. Dates of the template are counted in working days from it. */
    startDate: calendarDate,
    /** The person for each role of the template. A role left out stays empty. */
    roles: z.record(identifier).optional(),
    /** The client (a WeldCRM company). */
    clientId: identifier.nullish(),
    copy: instantiateCopySchema.optional(),
  })
  .strict();
export type InstantiateTemplateInput = z.infer<typeof instantiateTemplateSchema>;

/** A template as the list answers it: no blueprint, a summary of it. */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  shared: boolean;
  sourceProjectId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  summary: BlueprintSummary;
  /** How many projects were created from it. */
  usageCount: number;
}

export interface ProjectTemplateDetail extends ProjectTemplate {
  blueprint: Blueprint;
}

export interface InstantiateResult {
  project: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    projectManagerId: string | null;
  };
  counts: {
    members: number;
    stages: number;
    phases: number;
    milestones: number;
    deliverables: number;
    tasks: number;
    dependencies: number;
    raidItems: number;
  };
}
