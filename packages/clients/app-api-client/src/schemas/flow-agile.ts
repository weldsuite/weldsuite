/**
 * WeldFlow agile delivery: a project's delivery approach and item types
 * (`settings.delivery`, `PUT /api/projects/:id/delivery`), sprints with their
 * start and complete actions and report (`/api/sprints`), epic roll-ups
 * (`GET /api/tasks/epics`) and sprint retros (`/api/project-lessons` with a
 * `sprintId`).
 *
 * Served by the Rust backend only (EU and self-hosted); Global hides it
 * (`flow-agile` in `GLOBAL_UNAVAILABLE_FEATURES`). Design: weldsuite-documentation
 * `design/modules/weldflow-agile.md`, ADRs FLOW-022 to FLOW-024.
 *
 * Request bodies are `.strict()`: a field the API does not accept is a 400.
 */

import { z } from 'zod';

import { LESSON_CATEGORIES, LESSON_TEXT_MAX } from './project-closing';

const identifier = z.string().min(1).max(255);

// ── Delivery approach ───────────────────────────────────────────────────────

/** How a project delivers. `tasklist` is WeldFlow as it was: the default. */
export const DELIVERY_APPROACHES = ['tasklist', 'predictive', 'scrum', 'kanban', 'hybrid'] as const;
export type DeliveryApproach = (typeof DELIVERY_APPROACHES)[number];

/** The values of `tasks.type` the agile screens know. Others show as `task`. */
export const ITEM_TYPES = ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'subtask'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Types that hold other items through `epicId`. */
export const CONTAINER_ITEM_TYPES: readonly ItemType[] = ['epic', 'feature'];

/** What a `story` is called: a product backlog item, or a user story. */
export const ITEM_TYPE_NAMINGS = ['pbi', 'story'] as const;
export type ItemTypeNaming = (typeof ITEM_TYPE_NAMINGS)[number];

export const DEFAULT_ENABLED_ITEM_TYPES: readonly ItemType[] = ['epic', 'story', 'bug', 'task', 'spike', 'subtask'];

export const SPRINT_LENGTH_MIN = 1;
export const SPRINT_LENGTH_MAX = 42;
export const SPRINT_LENGTH_DEFAULT = 14;
export const WIP_LIMIT_MAX = 999;
export const DEFINITION_OF_DONE_MAX_ITEMS = 20;
export const DEFINITION_OF_DONE_ITEM_MAX = 200;

export const itemTypeSettingsSchema = z
  .object({
    naming: z.enum(ITEM_TYPE_NAMINGS),
    /** Epics hold features, features hold items. */
    featureLevel: z.boolean(),
    enabled: z.array(z.enum(ITEM_TYPES)).max(ITEM_TYPES.length),
  })
  .strict();
export type ItemTypeSettings = z.infer<typeof itemTypeSettingsSchema>;

/** `PUT /api/projects/:id/delivery`: the whole setting; left-out keys take their defaults. */
export const deliverySettingsInputSchema = z
  .object({
    approach: z.enum(DELIVERY_APPROACHES),
    sprintLengthDays: z.number().int().min(SPRINT_LENGTH_MIN).max(SPRINT_LENGTH_MAX).optional(),
    itemTypes: itemTypeSettingsSchema.optional(),
    /** Soft limits per pipeline stage id: the board warns, nothing is refused. */
    wipLimits: z.record(z.string().min(1).max(40), z.number().int().min(1).max(WIP_LIMIT_MAX)).optional(),
    definitionOfDone: z
      .array(z.string().trim().min(1).max(DEFINITION_OF_DONE_ITEM_MAX))
      .max(DEFINITION_OF_DONE_MAX_ITEMS)
      .optional(),
  })
  .strict();
export type DeliverySettingsInput = z.infer<typeof deliverySettingsInputSchema>;

/** `settings.delivery` as stored: every key filled. */
export interface DeliverySettings {
  approach: DeliveryApproach;
  sprintLengthDays: number;
  itemTypes: ItemTypeSettings;
  wipLimits: Record<string, number>;
  definitionOfDone: string[];
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  approach: 'tasklist',
  sprintLengthDays: SPRINT_LENGTH_DEFAULT,
  itemTypes: { naming: 'pbi', featureLevel: false, enabled: [...DEFAULT_ENABLED_ITEM_TYPES] },
  wipLimits: {},
  definitionOfDone: [],
};

/**
 * `settings.delivery` read leniently: a missing or malformed key takes its
 * default, so a project that never chose an approach is a task list.
 */
export function readDeliverySettings(raw: unknown): DeliverySettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_DELIVERY_SETTINGS;
  const value = raw as Record<string, unknown>;
  const field = <T>(schema: z.ZodType<T>, key: string, fallback: T): T => {
    const parsed = schema.safeParse(value[key]);
    return parsed.success ? parsed.data : fallback;
  };
  const shape = deliverySettingsInputSchema.shape;
  return {
    approach: field(shape.approach, 'approach', DEFAULT_DELIVERY_SETTINGS.approach),
    sprintLengthDays: field(
      shape.sprintLengthDays.unwrap(),
      'sprintLengthDays',
      DEFAULT_DELIVERY_SETTINGS.sprintLengthDays,
    ),
    itemTypes: field(itemTypeSettingsSchema, 'itemTypes', DEFAULT_DELIVERY_SETTINGS.itemTypes),
    wipLimits: field(shape.wipLimits.unwrap(), 'wipLimits', DEFAULT_DELIVERY_SETTINGS.wipLimits),
    definitionOfDone: field(
      shape.definitionOfDone.unwrap(),
      'definitionOfDone',
      DEFAULT_DELIVERY_SETTINGS.definitionOfDone,
    ),
  };
}

// ── Sprints ─────────────────────────────────────────────────────────────────

export const SPRINT_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

const countAndPoints = z.object({ points: z.number(), count: z.number().int() });

export const burndownPointSchema = z.object({
  /** `YYYY-MM-DD`, UTC. */
  date: z.string(),
  /** Null for days still to come. */
  remaining: z.number().nullable(),
  ideal: z.number(),
});
export type BurndownPoint = z.infer<typeof burndownPointSchema>;

/**
 * A sprint's numbers: live while it runs, frozen when it completes
 * (ADR FLOW-024). Items are the sprint's top-level tasks; points are story
 * points (none counts as 0); cancelled items are left out.
 */
export const sprintReportSchema = z.object({
  committed: countAndPoints.extend({ taskIds: z.array(z.string()) }),
  completed: countAndPoints,
  added: countAndPoints,
  removed: countAndPoints,
  carriedOver: countAndPoints.extend({
    taskIds: z.array(z.string()),
    toSprintId: z.string().nullable(),
    toBacklog: z.number().int(),
  }),
  goalMet: z.boolean().nullable(),
  burndown: z.array(burndownPointSchema),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});
export type SprintReport = z.infer<typeof sprintReportSchema>;

/** A sprint as the routes answer it. `report` only once it was started. */
export const sprintSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    goal: z.string().nullable(),
    status: z.string(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    velocity: z.number().nullable(),
    storyPointsCommitted: z.number().nullable(),
    storyPointsCompleted: z.number().nullable(),
    report: sprintReportSchema.partial().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type Sprint = z.infer<typeof sprintSchema>;

/** `POST /api/sprints`. */
export const createSprintInputSchema = z.object({
  projectId: identifier,
  name: z.string().trim().min(1).max(255),
  goal: z.string().max(2000).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
});
export type CreateSprintInput = z.infer<typeof createSprintInputSchema>;

/** `PATCH /api/sprints/:id`. */
export const updateSprintInputSchema = createSprintInputSchema.omit({ projectId: true }).partial();
export type UpdateSprintInput = z.infer<typeof updateSprintInputSchema>;

/** `POST /api/sprints/:id/start`: only a planned sprint, one active sprint per project. */
export const startSprintInputSchema = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    goal: z.string().max(2000).optional(),
  })
  .strict();
export type StartSprintInput = z.infer<typeof startSprintInputSchema>;

export const CARRY_OVER_TARGETS = ['next', 'backlog'] as const;
export type CarryOverTarget = (typeof CARRY_OVER_TARGETS)[number];

/** `POST /api/sprints/:id/complete`: where each unfinished item goes. */
export const completeSprintInputSchema = z
  .object({
    goalMet: z.boolean().nullable().optional(),
    /** Unfinished items not listed in `items` go here. Default `next`. */
    moveTo: z.enum(CARRY_OVER_TARGETS).optional(),
    /** A planned sprint of the project; else the first planned one, else a new one. */
    nextSprintId: z.string().optional(),
    /** Put the items in a new sprint even when the project has a planned one. */
    createNext: z.boolean().optional(),
    items: z
      .array(z.object({ taskId: z.string().min(1), moveTo: z.enum(CARRY_OVER_TARGETS) }).strict())
      .max(1000)
      .optional(),
  })
  .strict();
export type CompleteSprintInput = z.infer<typeof completeSprintInputSchema>;

export interface CompleteSprintResult {
  sprint: Sprint;
  nextSprintId: string | null;
  report: SprintReport;
}

// ── Epics ───────────────────────────────────────────────────────────────────

/** `GET /api/tasks/epics?projectId=`: an epic or feature with its items rolled up. */
export const epicRollupSchema = z.object({
  id: z.string(),
  number: z.number().nullable().optional(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  priority: z.string().nullable().optional(),
  /** A feature's epic; null for an epic. */
  epicId: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  items: z.number().int(),
  done: z.number().int(),
  points: z.number(),
  donePoints: z.number(),
});
export type EpicRollup = z.infer<typeof epicRollupSchema>;

/** The agile fields of `PATCH /api/tasks/:id` (Rust only for `epicId` and `acceptanceCriteria`). */
export interface TaskAgileInput {
  type?: string;
  sprintId?: string | null;
  epicId?: string | null;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;
}

// ── Retros ──────────────────────────────────────────────────────────────────

/** A sprint's retro columns: the lesson categories, plus actions. */
export const RETRO_CATEGORIES = [...LESSON_CATEGORIES, 'action'] as const;
export type RetroCategory = (typeof RETRO_CATEGORIES)[number];

const retroText = z.string().trim().min(1).max(LESSON_TEXT_MAX);

/** `POST /api/project-lessons` with a `sprintId`. */
export const createRetroCardInputSchema = z
  .object({
    projectId: identifier,
    sprintId: identifier,
    category: z.enum(RETRO_CATEGORIES),
    text: retroText,
  })
  .strict();
export type CreateRetroCardInput = z.infer<typeof createRetroCardInputSchema>;

/** `PATCH /api/project-lessons/:id` of a retro card. */
export const updateRetroCardInputSchema = z
  .object({ category: z.enum(RETRO_CATEGORIES).optional(), text: retroText.optional() })
  .strict();
export type UpdateRetroCardInput = z.infer<typeof updateRetroCardInputSchema>;

/** A retro card as the lesson routes answer it. */
export const retroCardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sprintId: z.string().optional(),
  category: z.enum(RETRO_CATEGORIES),
  text: z.string(),
  authorId: z.string(),
  voteCount: z.number().int(),
  votedByMe: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RetroCard = z.infer<typeof retroCardSchema>;
