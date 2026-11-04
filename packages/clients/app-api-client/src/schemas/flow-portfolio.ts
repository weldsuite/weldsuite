/**
 * WeldFlow portfolio: capacity (load per member and week, bookings, resource
 * requests, member profiles) and project intake (requests, scoring, roadmap,
 * workspace settings).
 *
 * Request schemas for `/api/capacity` and `/api/project-requests`, the
 * vocabulary they share with `@weldsuite/flow-domain/capacity` and `/intake`,
 * and the shapes they answer. Design: weldsuite-documentation
 * `design/modules/weldflow-delivery-and-portfolio.md` ("Capacity", "Intake").
 *
 * Request bodies are `.strict()`: a field the API does not accept is a 400 and
 * never silently dropped. Dates are calendar dates (`YYYY-MM-DD`); the calendar
 * check (a real day, the end not before the start) is a business rule in
 * flow-domain, so both backends answer it alike.
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Capacity is read for at most this many ISO weeks. */
export const MAX_CAPACITY_WEEKS = 26;
/** The weeks shown when `to` is left out. */
export const DEFAULT_CAPACITY_WEEKS = 14;
/** The roadmap spans at most this many quarters. */
export const MAX_ROADMAP_QUARTERS = 8;
/** The quarters the roadmap shows when `to` is left out. */
export const DEFAULT_ROADMAP_QUARTERS = 4;
/** Contract hours of a member who has no profile. */
export const DEFAULT_WEEKLY_HOURS = 40;
/** A project name the caller may not see. */
export const OTHER_PROJECT_NAME = 'Other project';

/**
 * How full a person's week is, from the percentage of their contract hours:
 * `none` (nothing booked), `under` (below 50), `ok` (50 to 79), `full` (80 to
 * 100), `over` (101 to 120), `critical` (more than 120, or hours booked on a
 * person with no contract hours).
 */
export const CAPACITY_BANDS = ['none', 'under', 'ok', 'full', 'over', 'critical'] as const;
export type CapacityBand = (typeof CAPACITY_BANDS)[number];

export const RESOURCE_REQUEST_STATUSES = ['open', 'booked', 'cancelled'] as const;
export type ResourceRequestStatus = (typeof RESOURCE_REQUEST_STATUSES)[number];

export const PROJECT_REQUEST_STATUSES = ['new', 'assessing', 'approved', 'rejected', 'converted'] as const;
export type ProjectRequestStatus = (typeof PROJECT_REQUEST_STATUSES)[number];

/** The scoring scale: every criterion is rated 1 to 5. */
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

// ── Building blocks ─────────────────────────────────────────────────────────

const identifier = z.string().min(1).max(255);
/** A calendar date, `YYYY-MM-DD`. Whether it is a real day is checked in flow-domain. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_MESSAGE = 'Use a date as YYYY-MM-DD';
const isoDate = z.string().regex(DATE_PATTERN, DATE_MESSAGE);
/** Hours per week of a booking or request: more than nothing, at most a whole week. */
const hoursPerWeek = z.number().min(0.01).max(168);
const skill = z.string().trim().min(1).max(100);
/** A money amount: a non-negative number, stored with two decimals. */
const amount = z.number().finite().min(0).max(9_999_999_999_999);
const rating = z.number().int().min(SCORE_MIN).max(SCORE_MAX);
const queryDate = z.string().regex(DATE_PATTERN, DATE_MESSAGE);

export const neededSkillSchema = z
  .object({
    skill,
    hoursPerWeek: hoursPerWeek.optional(),
  })
  .strict();
export type NeededSkillInput = z.infer<typeof neededSkillSchema>;

// ── Capacity: bookings ──────────────────────────────────────────────────────

export const createBookingSchema = z
  .object({
    memberId: identifier,
    /** A booking is on a project or held for a request: exactly one of the two. */
    projectId: identifier.nullish(),
    requestId: identifier.nullish(),
    startsOn: isoDate,
    endsOn: isoDate,
    hoursPerWeek,
    tentative: z.boolean().optional(),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/** Who is booked, and on what, never changes: delete the booking and make another. */
export const updateBookingSchema = z
  .object({
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
    hoursPerWeek: hoursPerWeek.optional(),
    tentative: z.boolean().optional(),
  })
  .strict();
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

export const listBookingsQuerySchema = z.object({
  memberId: z.string().optional(),
  projectId: z.string().optional(),
  requestId: z.string().optional(),
  from: queryDate.optional(),
  to: queryDate.optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Capacity: resource requests ─────────────────────────────────────────────

export const createResourceRequestSchema = z
  .object({
    projectId: identifier,
    skill,
    hoursPerWeek,
    startsOn: isoDate,
    endsOn: isoDate,
  })
  .strict();
export type CreateResourceRequestInput = z.infer<typeof createResourceRequestSchema>;

export const updateResourceRequestSchema = z
  .object({
    skill: skill.optional(),
    hoursPerWeek: hoursPerWeek.optional(),
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
    /** An open request is withdrawn with `cancelled`. */
    status: z.enum(['cancelled']).optional(),
  })
  .strict();
export type UpdateResourceRequestInput = z.infer<typeof updateResourceRequestSchema>;

export const listResourceRequestsQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(RESOURCE_REQUEST_STATUSES).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

export const bookResourceRequestSchema = z
  .object({
    memberId: identifier,
    tentative: z.boolean().optional(),
  })
  .strict();
export type BookResourceRequestInput = z.infer<typeof bookResourceRequestSchema>;

// ── Capacity: load and profiles ─────────────────────────────────────────────

export const capacityQuerySchema = z.object({
  from: queryDate.optional(),
  to: queryDate.optional(),
  skill: z.string().optional(),
  tentative: z.enum(['true', 'false', '1', '0']).optional(),
});

export const updateMemberProfileSchema = z
  .object({
    weeklyHours: z.number().min(0).max(168).optional(),
    skills: z.array(skill).max(30).optional(),
  })
  .strict();
export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>;

// ── Intake: requests ────────────────────────────────────────────────────────

const requestFields = {
  businessCase: z.string().max(10_000).nullish(),
  estimatedCost: amount.nullish(),
  estimatedValue: amount.nullish(),
  neededSkills: z.array(neededSkillSchema).max(20).optional(),
  desiredStart: isoDate.nullish(),
  desiredEnd: isoDate.nullish(),
};

export const createProjectRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    ...requestFields,
  })
  .strict();
export type CreateProjectRequestInput = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    ...requestFields,
  })
  .strict();
export type UpdateProjectRequestInput = z.infer<typeof updateProjectRequestSchema>;

export const listProjectRequestsQuerySchema = z.object({
  status: z.enum(PROJECT_REQUEST_STATUSES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/** The rating of each criterion of the scoring model, by criterion key. */
export const scoreProjectRequestSchema = z
  .object({
    scores: z.record(rating),
  })
  .strict();
export type ScoreProjectRequestInput = z.infer<typeof scoreProjectRequestSchema>;

export const convertProjectRequestSchema = z
  .object({
    projectId: identifier,
  })
  .strict();
export type ConvertProjectRequestInput = z.infer<typeof convertProjectRequestSchema>;

export const roadmapQuerySchema = z.object({
  from: queryDate.optional(),
  to: queryDate.optional(),
  tentative: z.enum(['true', 'false', '1', '0']).optional(),
});

// ── Intake: workspace settings ──────────────────────────────────────────────

export const scoringCriterionSchema = z
  .object({
    key: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(100),
    /** Whole percent; the weights of a model add up to 100. */
    weight: z.number().int().min(0).max(100),
    /** Risk and effort: a lower rating is better, so the rating counts as 6 - value. */
    inverse: z.boolean(),
  })
  .strict();
export type ScoringCriterionInput = z.infer<typeof scoringCriterionSchema>;

export const updateFlowSettingsSchema = z
  .object({
    scoringModel: z.array(scoringCriterionSchema).min(1).max(12).optional(),
    portfolioBoardIds: z.array(identifier).max(50).optional(),
    expenseApprovalLimit: amount.nullish(),
  })
  .strict();
export type UpdateFlowSettingsInput = z.infer<typeof updateFlowSettingsSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export interface CapacityWeek {
  /** ISO week, `2026-W45`. */
  week: string;
  /** The Monday. */
  startsOn: string;
  /** The Sunday. */
  endsOn: string;
}

export interface CapacityCell {
  /** Hours booked or estimated that week (tentative ones only when asked for). */
  hours: number;
  /** The part of `hours` that comes from tentative bookings. */
  tentativeHours: number;
  /** Of the member's contract hours; null when they have none. */
  percent: number | null;
  band: CapacityBand;
}

/** One project (or request, for a tentative booking held for one) in a member's load. */
export interface CapacityProjectRow {
  projectId: string | null;
  requestId: string | null;
  /** The project's name, the request's title, or "Other project" for a project the caller is not in. */
  name: string;
  /** False for a project the caller is not a member of: only its hours show. */
  accessible: boolean;
  hours: number[];
  tentativeHours: number[];
}

export interface MemberCapacity {
  memberId: string;
  weeklyHours: number;
  skills: string[];
  hasProfile: boolean;
  cells: CapacityCell[];
  projects: CapacityProjectRow[];
}

export interface CapacitySummary {
  memberCount: number;
  bookedHours: number;
  capacityHours: number;
  percent: number | null;
  /** Person-weeks above 100 percent. */
  overbookedPersonWeeks: number;
}

export interface CapacityTotals {
  bookedHours: number;
  capacityHours: number;
}

export interface CapacityResponse {
  from: string;
  to: string;
  tentative: boolean;
  weeks: CapacityWeek[];
  /** Team totals per week, aligned with `weeks`. */
  totals: CapacityTotals[];
  members: MemberCapacity[];
  summary: CapacitySummary;
}

export interface ResourceBooking {
  id: string;
  memberId: string;
  projectId: string | null;
  requestId: string | null;
  startsOn: string;
  endsOn: string;
  hoursPerWeek: string;
  tentative: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRequest {
  id: string;
  projectId: string;
  /** "Other project" for a project the caller is not a member of. */
  projectName: string;
  skill: string;
  hoursPerWeek: string;
  startsOn: string;
  endsOn: string;
  status: ResourceRequestStatus;
  bookingId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemberSuggestion {
  memberId: string;
  skills: string[];
  weeklyHours: number;
  /** The fewest free hours in any week of the request: what the person can take on every week. */
  freeHoursPerWeek: number;
  averageFreeHoursPerWeek: number;
  /** Free for the whole request, every week. */
  coversRequest: boolean;
}

export interface MemberProfile {
  memberId: string;
  weeklyHours: number;
  skills: string[];
  /** False when the member has no profile yet: the defaults are shown. */
  hasProfile: boolean;
  updatedAt: string | null;
}

export interface ScoreBreakdownLine {
  key: string;
  label: string;
  weight: number;
  inverse: boolean;
  /** The rating, null when not rated yet. */
  value: number | null;
  /** The points it adds to the score, null when not rated yet. */
  points: number | null;
}

export interface SkillFit {
  skill: string;
  needHoursPerWeek: number | null;
  /** The fewest hours the team has free in any week of the window, for people with this skill. */
  freeHoursPerWeek: number;
  /** Weeks of the window where the free hours are below the need. */
  shortWeeks: number;
  weeks: number;
  short: boolean;
}

export interface ProjectRequest {
  id: string;
  number: number;
  /** `REQ-14`. */
  code: string;
  title: string;
  requestedBy: string;
  businessCase: string | null;
  estimatedCost: string | null;
  estimatedValue: string | null;
  scores: Record<string, number>;
  /** The weighted sum, null until every criterion is rated. */
  score: number | null;
  neededSkills: NeededSkillInput[];
  desiredStart: string | null;
  desiredEnd: string | null;
  status: ProjectRequestStatus;
  submittedAt: string | null;
  projectId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowWorkspaceSettings {
  /** Null until a workspace saves its settings: the defaults are shown. */
  id: string | null;
  scoringModel: ScoringCriterionInput[];
  portfolioBoardIds: string[];
  expenseApprovalLimit: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface IntakeFunnel {
  counts: Record<ProjectRequestStatus, number>;
  /** Requests filed in the last 7 days. */
  newLast7Days: number;
  /** Days the oldest request under assessment has been waiting, null when none is. */
  oldestAssessingDays: number | null;
}

export interface RoadmapBucket {
  /** `2026-Q4` or `2026-11`. */
  key: string;
  startsOn: string;
  endsOn: string;
  bookedHours: number;
  capacityHours: number;
  percent: number | null;
}

export interface RoadmapItem {
  type: 'project' | 'request';
  id: string;
  /** The request's `REQ-14`; null for a project. */
  code: string | null;
  /** "Other project" for a project the caller is not a member of. */
  name: string;
  accessible: boolean;
  /** A project's status, or the request's (`assessing` is "if approved", `approved` is not started). */
  status: string;
  startsOn: string;
  endsOn: string;
  score: number | null;
}

export interface RoadmapResponse {
  from: string;
  to: string;
  quarters: RoadmapBucket[];
  months: RoadmapBucket[];
  items: RoadmapItem[];
}
