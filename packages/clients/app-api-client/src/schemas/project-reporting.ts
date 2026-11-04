/**
 * WeldFlow project reporting: status reports (`/api/project-status-reports`)
 * and the stakeholder register with its RACI and communication plan
 * (`/api/project-stakeholders`). Design: weldsuite-documentation
 * `design/modules/weldflow-delivery-and-portfolio.md`, ADR FLOW-018.
 *
 * Request schemas and the shapes the routes answer. Top-level request bodies
 * are `.strict()` (an unknown key is a 400, never silently dropped); the
 * objects nested in them are not (an unknown key inside a list item is
 * dropped). Flow-api validates against these, and the Rust backend reads the
 * same rules (rust/modules/flow/src/reporting_body.rs).
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const STATUS_REPORT_STATUSES = ['draft', 'published'] as const;
export type StatusReportStatus = (typeof STATUS_REPORT_STATUSES)[number];

/** `grey` is "no data yet" (no baseline, no benefits); the rest is the usual traffic light. */
export const STATUS_COLOURS = ['green', 'amber', 'red', 'grey'] as const;
export type StatusColour = (typeof STATUS_COLOURS)[number];

/** The colours a project manager can set by hand (grey only ever means "no data"). */
export const OVERRIDE_COLOURS = ['green', 'amber', 'red'] as const;
export type OverrideColour = (typeof OVERRIDE_COLOURS)[number];

export const STATUS_REPORT_AREAS = ['schedule', 'budget', 'scope', 'risk', 'benefits'] as const;
export type StatusReportAreaKey = (typeof STATUS_REPORT_AREAS)[number];

export const STATUS_REPORT_CADENCES = ['weekly', 'biweekly', 'monthly'] as const;
export type StatusReportCadence = (typeof STATUS_REPORT_CADENCES)[number];

/** `sponsor`: the sponsor only; `all_stakeholders`; `portal_contacts`: stakeholders with portal access. */
export const STATUS_REPORT_RECIPIENT_RULES = ['sponsor', 'all_stakeholders', 'portal_contacts'] as const;
export type StatusReportRecipientRule = (typeof STATUS_REPORT_RECIPIENT_RULES)[number];

export const STAKEHOLDER_ATTITUDES = ['supportive', 'neutral', 'resistant'] as const;
export const STAKEHOLDER_ENGAGEMENT = ['unaware', 'resistant', 'neutral', 'supportive', 'leading'] as const;
export const STAKEHOLDER_KINDS = ['member', 'contact'] as const;
export type StakeholderKind = (typeof STAKEHOLDER_KINDS)[number];

export const RACI_SUBJECT_TYPES = ['deliverable', 'change_requests', 'go_live'] as const;
export type RaciSubjectType = (typeof RACI_SUBJECT_TYPES)[number];

/** Responsible, Accountable, Consulted, Informed. */
export const RACI_LETTERS = ['R', 'A', 'C', 'I'] as const;
export type RaciLetter = (typeof RACI_LETTERS)[number];

/** An ISO week (`2026-W45`) or a month (`2026-11`): the same check as the table's. */
export const STATUS_REPORT_PERIOD_PATTERN = /^[0-9]{4}-(W(0[1-9]|[1-4][0-9]|5[0-3])|(0[1-9]|1[0-2]))$/;
export const STATUS_REPORT_PERIOD_MESSAGE = 'period must be an ISO week (2026-W45) or a month (2026-11)';

// ── Building blocks ─────────────────────────────────────────────────────────

const identifier = z.string().min(1).max(255);
const isoDateTime = z.string().datetime({ offset: true });
/** Stakeholder scores on the power/interest grid. */
const scale = z.number().int().min(1).max(5);
const period = z.string().regex(STATUS_REPORT_PERIOD_PATTERN, STATUS_REPORT_PERIOD_MESSAGE);

/** One line of the report's "done" or "next" list: a task, a deliverable, or free text. */
const reportItem = z.object({
  taskId: identifier.nullish(),
  text: z.string().trim().min(1).max(500),
  /** `TASK-12`, `D2`: what the sweep filled in. A line without a code is the project manager's own. */
  code: z.string().max(30).nullish(),
  date: isoDateTime.nullish(),
});

const recipients = z.object({
  /** `project_stakeholders.id` values. */
  stakeholderIds: z.array(identifier).max(200).optional(),
});

// ── Status reports: requests ────────────────────────────────────────────────

export const listStatusReportsQuerySchema = z.object({
  projectId: identifier,
  status: z.enum(STATUS_REPORT_STATUSES).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/** `period` defaults to the one the project's cadence reports on now. */
export const createStatusReportSchema = z
  .object({
    projectId: identifier,
    period: period.optional(),
  })
  .strict();

/**
 * One area's override: a colour with the reason, or `null` to go back to the
 * computed colour. The reason is what the sponsor reads under the colour.
 */
const areaOverride = z.object({
  key: z.enum(STATUS_REPORT_AREAS),
  override: z
    .object({
      colour: z.enum(OVERRIDE_COLOURS),
      reason: z.string().trim().min(1).max(1_000),
    })
    .nullable(),
});

/**
 * Edits to a draft. `overall` replaces the suggested overall colour; `done`
 * and `next` replace the lists as a whole (a line with a code is kept in step
 * with the data on refresh, a free-text line is yours).
 */
export const updateStatusReportSchema = z
  .object({
    summary: z.string().trim().max(10_000).nullish(),
    overall: z.enum(OVERRIDE_COLOURS).optional(),
    areas: z.array(areaOverride).max(5).optional(),
    done: z.array(reportItem).max(50).optional(),
    next: z.array(reportItem).max(50).optional(),
    clientVisible: z.boolean().optional(),
    /** `null`: back to the schedule's recipients. */
    recipients: recipients.nullish(),
  })
  .strict();

/** `statusReport` in `projects.settings`: when the sweep drafts the next report and who gets it. */
export const statusReportSettingsSchema = z.object({
  cadence: z.enum(STATUS_REPORT_CADENCES),
  /** ISO weekday: 1 = Monday ... 7 = Sunday (ignored for monthly). */
  weekday: z.number().int().min(1).max(7),
  /** Hour of day, 0 to 23: when the report is due to go out. */
  hour: z.number().int().min(0).max(23),
  recipients: z.object({
    stakeholderIds: z.array(identifier).max(200).optional(),
    rule: z.enum(STATUS_REPORT_RECIPIENT_RULES).optional(),
  }),
});

/**
 * Both keys are optional: an absent key stays as it is. `statusReport: null`
 * turns the schedule off; `riskAppetite` is the highest risk score (1 to 25)
 * the project accepts without escalating (the risk area's colour reads it).
 */
export const putStatusReportSettingsSchema = z
  .object({
    statusReport: statusReportSettingsSchema.nullish(),
    riskAppetite: z.number().int().min(1).max(25).optional(),
  })
  .strict();

// ── Status reports: responses ───────────────────────────────────────────────

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();

/** What the computed colour of an area says, as a code the UI turns into a sentence. */
export const statusAreaComputedSchema = z.object({
  colour: z.enum(STATUS_COLOURS),
  /** `schedule.behind`, `budget.no_data`, ... The UI has a sentence for each. */
  code: z.string(),
  params: z.record(z.unknown()),
});

export const statusReportAreaSchema = z.object({
  key: z.enum(STATUS_REPORT_AREAS),
  /** The colour in effect: the computed one, or the project manager's override. */
  colour: z.enum(STATUS_COLOURS),
  /** The project manager's reason for an override; null while the colour is computed. */
  reason: nullableString,
  /** True while the colour is the computed one. */
  auto: z.boolean(),
  computed: statusAreaComputedSchema.nullable(),
});

export const statusReportItemSchema = z.object({
  taskId: nullableString,
  text: z.string(),
  /** `TASK-12`, `D2`, `DEC-5`; null on a line the project manager wrote. */
  code: nullableString,
  date: nullableString,
});

const snapshotRiskSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  score: z.number().int(),
  band: z.string(),
  ownerId: nullableString,
  previousScore: nullableInt,
});

const snapshotDecisionSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  deciderId: nullableString,
  dueAt: nullableString,
});

const snapshotChangeSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  status: z.string(),
  costDelta: nullableString,
  scheduleDeltaDays: nullableInt,
});

const snapshotMilestoneSchema = z.object({
  /** `milestone`, `deliverable` or `go_live`. */
  kind: z.string(),
  id: nullableString,
  name: z.string(),
  baselineDate: nullableString,
  forecastDate: nullableString,
  /** Calendar days the forecast is later than the baseline (negative: earlier). */
  varianceDays: nullableInt,
});

/** The figures and lists a report shows, as of `asOf`. Frozen on publish. */
export const statusReportSnapshotSchema = z
  .object({
    version: z.number().int(),
    asOf: z.string(),
    baselineVersion: nullableInt,
    currency: nullableString,
    /** What the data suggested when the snapshot was taken; the areas' colours may differ by override. */
    computed: z.object({
      overall: z.enum(STATUS_COLOURS),
      areas: z.record(statusAreaComputedSchema),
    }),
    /** Raw figures behind the colours. Budget is only filled when the project has a finance snapshot. */
    figures: z
      .object({
        budget: z
          .object({
            week: z.string(),
            budget: nullableString,
            plannedValue: z.string(),
            earnedValue: z.string(),
            actualCost: z.string(),
            forecast: nullableString,
            cpi: z.number().nullable(),
            spi: z.number().nullable(),
          })
          .nullable(),
        pendingChanges: z.number().int(),
        riskAppetite: z.number().int(),
        openRisks: z.number().int(),
        highestRiskScore: nullableInt,
      })
      .passthrough(),
    topRisks: z.array(snapshotRiskSchema),
    decisions: z.array(snapshotDecisionSchema),
    changes: z.array(snapshotChangeSchema),
    milestones: z.array(snapshotMilestoneSchema),
    /** Published reports only: who the report went to, as it was sent. */
    recipients: z
      .array(z.object({ stakeholderId: nullableString, userId: nullableString, name: nullableString, kind: z.enum(STAKEHOLDER_KINDS) }))
      .optional(),
  })
  .passthrough();

export const resolvedRecipientSchema = z.object({
  stakeholderId: nullableString,
  userId: nullableString,
  name: nullableString,
  email: nullableString,
  kind: z.enum(STAKEHOLDER_KINDS),
});

/** A report as the list answers it. */
export const statusReportSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  period: z.string(),
  status: z.enum(STATUS_REPORT_STATUSES),
  overall: z.enum(STATUS_COLOURS).nullable(),
  areas: z.array(statusReportAreaSchema),
  summary: nullableString,
  clientVisible: z.boolean(),
  supersedesId: nullableString,
  /** The published report that corrects this one, when there is one. */
  supersededById: nullableString,
  publishedBy: nullableString,
  publishedAt: nullableString,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const statusReportSchema = statusReportSummarySchema.extend({
  done: z.array(statusReportItemSchema),
  next: z.array(statusReportItemSchema),
  snapshot: statusReportSnapshotSchema.nullable(),
  /** As stored: null means "the schedule's recipients at the time of sending". */
  recipients: z.object({ stakeholderIds: z.array(z.string()).optional() }).nullable(),
  /** Who the report goes to (a draft) or went to (a published report). */
  resolvedRecipients: z.array(resolvedRecipientSchema),
});

export const statusReportSettingsResponseSchema = z.object({
  projectId: z.string(),
  statusReport: z
    .object({
      cadence: z.enum(STATUS_REPORT_CADENCES),
      weekday: z.number().int(),
      hour: z.number().int(),
      recipients: z.object({ stakeholderIds: z.array(z.string()).optional(), rule: z.enum(STATUS_REPORT_RECIPIENT_RULES).optional() }),
    })
    .nullable(),
  riskAppetite: z.number().int(),
  /** When the sweep drafts the next report; null while the schedule is off. */
  nextDraftAt: nullableString,
});

// ── Stakeholders: requests ──────────────────────────────────────────────────

export const listStakeholdersQuerySchema = z.object({
  projectId: identifier,
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

const stakeholderFields = {
  organisation: z.string().trim().max(255).nullish(),
  role: z.string().trim().max(100).nullish(),
  influence: scale.optional(),
  interest: scale.optional(),
  attitude: z.enum(STAKEHOLDER_ATTITUDES).optional(),
  engagement: z.enum(STAKEHOLDER_ENGAGEMENT).optional(),
  notes: z.string().max(10_000).nullish(),
  lastContactAt: isoDateTime.nullish(),
};

/** Exactly one of `memberId` (a workspace member's user id) and `crmContactId` (a CRM person). */
export const createStakeholderSchema = z
  .object({
    projectId: identifier,
    memberId: identifier.nullish(),
    crmContactId: identifier.nullish(),
    ...stakeholderFields,
  })
  .strict();

/** The person never changes: remove the stakeholder and add another. */
export const updateStakeholderSchema = z.object(stakeholderFields).strict();

/** One cell of the matrix. */
const raciAssignment = z.object({
  stakeholderId: identifier,
  letter: z.enum(RACI_LETTERS),
});

/**
 * Replaces every assignment of one subject. `subjectId` is the deliverable's
 * id for `deliverable` and must be left out otherwise. At most one `A`.
 */
export const putRaciSchema = z
  .object({
    subjectType: z.enum(RACI_SUBJECT_TYPES),
    subjectId: identifier.nullish(),
    assignments: z.array(raciAssignment).max(200),
  })
  .strict();

/** `communicationPlan` in `projects.settings`. */
const communicationPlanEntry = z.object({
  what: z.string().trim().min(1).max(255),
  audience: z.string().trim().min(1).max(500),
  cadence: z.string().trim().min(1).max(100),
  channel: z.string().trim().min(1).max(255),
});

export const putCommunicationPlanSchema = z
  .object({
    communicationPlan: z.array(communicationPlanEntry).max(50),
  })
  .strict();

// ── Stakeholders: responses ─────────────────────────────────────────────────

export const stakeholderSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** `member` is on the team, `contact` is a CRM person (a client side stakeholder). */
  kind: z.enum(STAKEHOLDER_KINDS),
  memberId: nullableString,
  crmContactId: nullableString,
  name: nullableString,
  email: nullableString,
  organisation: nullableString,
  role: nullableString,
  influence: z.number().int(),
  interest: z.number().int(),
  attitude: z.enum(STAKEHOLDER_ATTITUDES),
  engagement: z.enum(STAKEHOLDER_ENGAGEMENT),
  notes: nullableString,
  lastContactAt: nullableString,
  portalAccess: z.boolean(),
  portalInvitedAt: nullableString,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const raciSubjectSchema = z.object({
  subjectType: z.enum(RACI_SUBJECT_TYPES),
  subjectId: nullableString,
  /** `D2` for a deliverable; null on the type-wide rows. */
  code: nullableString,
  /** The deliverable's title; null on the type-wide rows (the UI names them). */
  title: nullableString,
  assignments: z.array(raciAssignment),
});

export const raciMatrixSchema = z.object({
  projectId: z.string(),
  subjects: z.array(raciSubjectSchema),
});

export const communicationPlanResponseSchema = z.object({
  projectId: z.string(),
  communicationPlan: z.array(communicationPlanEntry),
});

// ── Types ───────────────────────────────────────────────────────────────────

export type ListStatusReportsQuery = z.infer<typeof listStatusReportsQuerySchema>;
export type CreateStatusReportInput = z.infer<typeof createStatusReportSchema>;
export type UpdateStatusReportInput = z.infer<typeof updateStatusReportSchema>;
export type StatusReportSettings = z.infer<typeof statusReportSettingsSchema>;
export type PutStatusReportSettingsInput = z.infer<typeof putStatusReportSettingsSchema>;
export type StatusAreaComputed = z.infer<typeof statusAreaComputedSchema>;
export type StatusReportArea = z.infer<typeof statusReportAreaSchema>;
export type StatusReportItem = z.infer<typeof statusReportItemSchema>;
export type StatusReportSnapshot = z.infer<typeof statusReportSnapshotSchema>;
export type ResolvedRecipient = z.infer<typeof resolvedRecipientSchema>;
export type StatusReportSummary = z.infer<typeof statusReportSummarySchema>;
export type StatusReport = z.infer<typeof statusReportSchema>;
export type StatusReportSettingsResponse = z.infer<typeof statusReportSettingsResponseSchema>;

export type ListStakeholdersQuery = z.infer<typeof listStakeholdersQuerySchema>;
export type CreateStakeholderInput = z.infer<typeof createStakeholderSchema>;
export type UpdateStakeholderInput = z.infer<typeof updateStakeholderSchema>;
export type PutRaciInput = z.infer<typeof putRaciSchema>;
export type PutCommunicationPlanInput = z.infer<typeof putCommunicationPlanSchema>;
export type CommunicationPlanEntry = z.infer<typeof communicationPlanEntry>;
export type RaciAssignment = z.infer<typeof raciAssignment>;
export type Stakeholder = z.infer<typeof stakeholderSchema>;
export type RaciSubject = z.infer<typeof raciSubjectSchema>;
export type RaciMatrix = z.infer<typeof raciMatrixSchema>;
export type CommunicationPlanResponse = z.infer<typeof communicationPlanResponseSchema>;
