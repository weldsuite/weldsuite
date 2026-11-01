/**
 * Response shapes of hr-api (WeldHR), everything under `/api/weldhr` except
 * payroll (`weldhr-payroll-responses`).
 *
 * The platform reads these through the interfaces in `domains/weldhr.ts`;
 * these Zod schemas mirror them and what the routes actually answer (whole
 * Drizzle rows on writes, decorated rows on reads), so the Rust backend's
 * answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-hr.ts`).
 *
 * Timestamps are ISO strings, `date` columns `YYYY-MM-DD`, `doublePrecision`
 * and `integer` columns numbers. Nullable where the column is.
 */

import { z } from 'zod';
import {
  hrAssigneeRoleSchema,
  hrAttendanceStatusSchema,
  hrChecklistKindSchema,
  hrCoachingCategorySchema,
  hrCoachingStatusSchema,
  hrDeclarationCategorySchema,
  hrDeclarationStatusSchema,
  hrEmployeeStatusSchema,
  hrEmploymentTypeSchema,
  hrEvaluationStatusSchema,
  hrKpiDirectionSchema,
  hrKpiUnitSchema,
  hrLeaveOverAllowanceSchema,
  hrLeaveStatusSchema,
  hrMilestoneStatusSchema,
  hrMilestoneTypeSchema,
  hrVisibilitySchema,
} from './weldhr';

const instant = z.string().datetime({ offset: true });
const nullableInstant = instant.nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableIsoDate = isoDate.nullable();
const nullableString = z.string().nullable();
const count = z.number().int().nonnegative();

const hrShiftRequestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const hrAbsenceStatusSchema = z.enum(['ongoing', 'completed']);
const hrAbsenceFirstDaySchema = z.enum(['full', 'half']);
const hrChecklistStatusSchema = z.enum(['in_progress', 'completed', 'cancelled']);
const hrAttendanceSourceSchema = z.enum(['portal', 'manual', 'import', 'api']);
const hrOpenShiftStatusSchema = z.enum(['open', 'cancelled']);

/** `{ archived }`: what deleting a leave type or a KPI answers (archived when it has history). */
export const hrArchivedResultSchema = z.object({ archived: z.boolean() });

/** `{ created, updated, errors }`: an attendance or KPI import. */
export const hrImportResultSchema = z.object({
  created: count,
  updated: count,
  errors: z.array(z.object({ row: z.number().int().positive(), reason: z.string() })),
});

// ── employees ───────────────────────────────────────────────────────────────

export const hrClientRefSchema = z.object({
  companyId: z.string(),
  companyName: nullableString,
  isPrimary: z.boolean(),
});

/** An `hr_employees` row without the sealed block (`toPublicEmployee`). */
export const hrEmployeeSchema = z.object({
  id: z.string(),
  employeeNumber: nullableString,
  firstName: z.string(),
  lastName: z.string(),
  preferredName: nullableString,
  displayName: z.string(),
  email: z.string(),
  phone: nullableString,
  avatarUrl: nullableString,
  pronouns: nullableString,
  jobTitle: nullableString,
  departmentId: nullableString,
  managerId: nullableString,
  userId: nullableString,
  employmentType: hrEmploymentTypeSchema,
  status: hrEmployeeStatusSchema,
  startDate: nullableIsoDate,
  endDate: nullableIsoDate,
  probationEndDate: nullableIsoDate,
  location: nullableString,
  timezone: nullableString,
  weeklyHours: z.number().nullable(),
  workLocationIds: z.array(z.string()).nullable(),
  customFields: z.record(z.unknown()).nullable(),
  hasSensitive: z.boolean(),
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

/** `GET /employees`: the public row with its department, manager and active clients. */
export const hrEmployeeListItemSchema = hrEmployeeSchema.extend({
  departmentName: nullableString,
  managerName: nullableString,
  clients: z.array(hrClientRefSchema),
});

/** `GET /employees/:employeeId`: the list item and who reports to them. */
export const hrEmployeeDetailSchema = hrEmployeeListItemSchema.extend({
  directReports: z.array(
    z.object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      preferredName: nullableString,
      displayName: z.string(),
      jobTitle: nullableString,
      avatarUrl: nullableString,
      status: hrEmployeeStatusSchema,
    }),
  ),
});

/** The decrypted sensitive block; payroll adds fields of its own, which pass. */
export const hrEmployeeSensitiveResponseSchema = z.object({
  dateOfBirth: nullableIsoDate.optional(),
  nationalId: nullableString.optional(),
  taxId: nullableString.optional(),
  address: nullableString.optional(),
  personalEmail: nullableString.optional(),
  personalPhone: nullableString.optional(),
  emergencyContactName: nullableString.optional(),
  emergencyContactPhone: nullableString.optional(),
  emergencyContactRelation: nullableString.optional(),
  bankAccount: nullableString.optional(),
  salaryAmount: z.number().nullable().optional(),
  salaryCurrency: nullableString.optional(),
  salaryPeriod: z.enum(['hour', 'month', 'year']).nullable().optional(),
  notes: nullableString.optional(),
});

export const hrAvailableMemberSchema = z.object({
  userId: z.string(),
  name: nullableString,
  email: nullableString,
  picture: nullableString,
  title: nullableString,
  phone: nullableString,
  memberType: z.enum(['INTERNAL', 'EMPLOYEE']),
});

export const hrOrgChartNodeSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  preferredName: nullableString,
  displayName: z.string(),
  jobTitle: nullableString,
  avatarUrl: nullableString,
  managerId: nullableString,
  departmentId: nullableString,
  status: hrEmployeeStatusSchema,
});

// ── departments ─────────────────────────────────────────────────────────────

export const hrDepartmentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableString,
  parentId: nullableString,
  headEmployeeId: nullableString,
  color: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

/** `GET /departments`: each with its live headcount. */
export const hrDepartmentSchema = hrDepartmentRowSchema.extend({ employeeCount: count });

// ── client assignments ──────────────────────────────────────────────────────

export const hrAssignmentRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: z.string(),
  role: nullableString,
  allocationPercent: z.number(),
  isPrimary: z.boolean(),
  startDate: isoDate,
  endDate: nullableIsoDate,
  notes: nullableString,
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrAssignmentSchema = hrAssignmentRowSchema.extend({
  companyName: nullableString,
  companyDeleted: z.boolean(),
  employeeName: z.string(),
  employeeJobTitle: nullableString,
  employeeAvatarUrl: nullableString,
  employeeStatus: hrEmployeeStatusSchema,
  isActive: z.boolean(),
});

export const hrClientAccountSchema = z.object({
  companyId: z.string(),
  companyName: nullableString,
  activeCount: count,
  totalCount: count,
  fte: z.number(),
});

/** `GET /clients/:companyId`. */
export const hrClientDetailSchema = z.object({
  company: z.object({ id: z.string(), name: z.string() }),
  assignments: z.array(hrAssignmentSchema),
});

// ── lifecycle ───────────────────────────────────────────────────────────────

export const hrChecklistTemplateItemResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableString.optional(),
  assigneeRole: hrAssigneeRoleSchema,
  dueOffsetDays: z.number().int(),
  visibleToEmployee: z.boolean(),
});

export const hrChecklistTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableString,
  kind: hrChecklistKindSchema,
  departmentId: nullableString,
  items: z.array(hrChecklistTemplateItemResponseSchema),
  isDefault: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrChecklistRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  templateId: nullableString,
  kind: hrChecklistKindSchema,
  name: z.string(),
  status: hrChecklistStatusSchema,
  anchorDate: nullableIsoDate,
  startedBy: nullableString,
  startedAt: instant,
  completedAt: nullableInstant,
  createdAt: instant,
  updatedAt: instant,
});

export const hrChecklistTaskRowSchema = z.object({
  id: z.string(),
  checklistId: z.string(),
  employeeId: z.string(),
  title: z.string(),
  description: nullableString,
  assigneeRole: hrAssigneeRoleSchema,
  assigneeUserId: nullableString,
  dueDate: nullableIsoDate,
  visibleToEmployee: z.boolean(),
  sortOrder: z.number().int(),
  completedAt: nullableInstant,
  completedBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

/** `GET /checklists`: each with its employee, tasks (with names) and progress. */
export const hrChecklistSchema = hrChecklistRowSchema.extend({
  employeeName: z.string(),
  tasks: z.array(
    hrChecklistTaskRowSchema.extend({
      assigneeName: nullableString,
      completedByName: nullableString,
    }),
  ),
  progress: z.object({ done: count, total: count }),
});

export const hrChecklistOutcomeSchema = z.object({
  checklistCompleted: z.boolean(),
  kind: hrChecklistKindSchema,
  employeeId: z.string(),
  employeeStatus: hrEmployeeStatusSchema.nullable(),
});

/** `PATCH /checklists/tasks/:taskId`. */
export const hrChecklistTaskUpdateSchema = z.object({
  task: hrChecklistTaskRowSchema,
  outcome: hrChecklistOutcomeSchema,
});

// ── shifts, shift requests, open shifts ─────────────────────────────────────

export const hrShiftRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: nullableString,
  startsAt: instant,
  endsAt: instant,
  workType: nullableString,
  breakStartsAt: nullableInstant,
  breakEndsAt: nullableInstant,
  notes: nullableString,
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrShiftSchema = hrShiftRowSchema.extend({
  employeeName: z.string(),
  companyName: nullableString,
});

export const hrShiftRequestRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  openShiftId: nullableString,
  startsAt: instant,
  endsAt: instant,
  workType: nullableString,
  note: nullableString,
  status: hrShiftRequestStatusSchema,
  shiftId: nullableString,
  requestedBy: nullableString,
  reviewedBy: nullableString,
  reviewedAt: nullableInstant,
  reviewNote: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrShiftRequestSchema = hrShiftRequestRowSchema.extend({
  employeeName: z.string(),
  reviewedByName: nullableString,
});

export const hrOpenShiftRowSchema = z.object({
  id: z.string(),
  companyId: nullableString,
  departmentId: nullableString,
  startsAt: instant,
  endsAt: instant,
  workType: nullableString,
  breakStartsAt: nullableInstant,
  breakEndsAt: nullableInstant,
  notes: nullableString,
  spots: z.number().int().positive(),
  status: hrOpenShiftStatusSchema,
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrOpenShiftSchema = hrOpenShiftRowSchema.extend({
  companyName: nullableString,
  departmentName: nullableString,
  filled: count,
  pending: count,
  spotsLeft: count,
});

// ── work locations ──────────────────────────────────────────────────────────

export const hrWorkLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: nullableString,
  latitude: z.number(),
  longitude: z.number(),
  radiusMeters: z.number().int(),
  isActive: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

// ── announcements ───────────────────────────────────────────────────────────

export const hrAnnouncementRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  departmentIds: z.array(z.string()),
  publishedAt: instant,
  notifiedAt: nullableInstant,
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrAnnouncementSchema = hrAnnouncementRowSchema.extend({
  departmentNames: z.array(z.string()),
  createdByName: nullableString,
  audienceCount: count,
  readCount: count,
});

export const hrAnnouncementReadSchema = z.object({
  employeeId: z.string(),
  employeeName: z.string(),
  readAt: nullableInstant,
});

// ── attendance ──────────────────────────────────────────────────────────────

export const hrAttendanceRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: nullableString,
  shiftId: nullableString,
  date: isoDate,
  clockIn: nullableInstant,
  clockOut: nullableInstant,
  breakMinutes: z.number().int(),
  workedMinutes: z.number().int().nullable(),
  lateMinutes: z.number().int(),
  status: hrAttendanceStatusSchema,
  source: hrAttendanceSourceSchema,
  notes: nullableString,
  approvedBy: nullableString,
  approvedAt: nullableInstant,
  clockInLocationId: nullableString,
  clockInLatitude: z.number().nullable(),
  clockInLongitude: z.number().nullable(),
  clockOutLocationId: nullableString,
  clockOutLatitude: z.number().nullable(),
  clockOutLongitude: z.number().nullable(),
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrAttendanceRecordSchema = hrAttendanceRowSchema.extend({
  employeeName: z.string(),
  companyName: nullableString,
  approvedByName: nullableString,
  clockInLocationName: nullableString,
  clockOutLocationName: nullableString,
});

export const hrAttendanceSummarySchema = z.object({
  records: count,
  workedMinutes: z.number(),
  lateMinutes: z.number(),
  byStatus: z.record(count),
  attendanceRate: z.number().nullable(),
});

/** `POST /attendance/approve`. */
export const hrAttendanceApprovedSchema = z.object({ approved: count });

// ── leave ───────────────────────────────────────────────────────────────────

export const hrLeaveTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: nullableString,
  isPaid: z.boolean(),
  requiresApproval: z.boolean(),
  defaultAllowanceDays: z.number().nullable(),
  overAllowance: hrLeaveOverAllowanceSchema,
  isActive: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});

export const hrLeaveBalanceSchema = z.object({
  leaveTypeId: z.string(),
  name: z.string(),
  color: nullableString,
  isPaid: z.boolean(),
  overAllowance: hrLeaveOverAllowanceSchema,
  allowance: z.number().nullable(),
  fullAllowance: z.number().nullable(),
  prorated: z.boolean(),
  used: z.number(),
  pending: z.number(),
  remaining: z.number().nullable(),
});

export const hrLeaveAllowanceSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  leaveTypeId: z.string(),
  year: z.number().int(),
  days: z.number(),
  createdAt: instant,
  updatedAt: instant,
});

export const hrLeaveRequestRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  leaveTypeId: z.string(),
  startDate: isoDate,
  endDate: isoDate,
  days: z.number(),
  reason: nullableString,
  status: hrLeaveStatusSchema,
  requestedBy: nullableString,
  reviewedBy: nullableString,
  reviewedAt: nullableInstant,
  reviewNote: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrLeaveRequestSchema = hrLeaveRequestRowSchema.extend({
  employeeName: z.string(),
  leaveTypeName: nullableString,
  leaveTypeColor: nullableString,
  reviewedByName: nullableString,
});

// ── declarations ────────────────────────────────────────────────────────────

/** `toPublicDeclaration`: the amount as a number, `hasReceipt` instead of the storage key. */
export const hrDeclarationSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  expenseDate: isoDate,
  category: hrDeclarationCategorySchema,
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: hrDeclarationStatusSchema,
  hasReceipt: z.boolean(),
  receiptFileName: nullableString,
  receiptContentType: nullableString,
  receiptSize: z.number().int().nullable(),
  submittedBy: nullableString,
  reviewedBy: nullableString,
  reviewedAt: nullableInstant,
  reviewNote: nullableString,
  paidBy: nullableString,
  paidAt: nullableInstant,
  createdAt: instant,
  updatedAt: instant,
});

export const hrDeclarationListItemSchema = hrDeclarationSchema.extend({
  employeeName: z.string(),
  reviewedByName: nullableString,
});

// ── absences ────────────────────────────────────────────────────────────────

export const hrAbsenceRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  startDate: isoDate,
  endDate: nullableIsoDate,
  firstDay: hrAbsenceFirstDaySchema,
  note: nullableString,
  reportedBy: nullableString,
  recoveredReportedBy: nullableString,
  recoveredReportedAt: nullableInstant,
  createdAt: instant,
  updatedAt: instant,
});

/** `GET /absences`: a report with its status, days, employee and who filed it. */
export const hrAbsenceSchema = hrAbsenceRowSchema.extend({
  status: hrAbsenceStatusSchema,
  days: z.number(),
  employeeName: z.string(),
  departmentName: nullableString,
  relapse: z.boolean(),
  reportedBySelf: z.boolean(),
  reportedByName: nullableString,
});

// ── coaching ────────────────────────────────────────────────────────────────

const hrCoachingActionItemResponseSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean() });

export const hrCoachingLogRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: nullableString,
  coachUserId: nullableString,
  coachName: nullableString,
  sessionDate: isoDate,
  category: hrCoachingCategorySchema,
  topic: z.string(),
  notes: nullableString,
  actionItems: z.array(hrCoachingActionItemResponseSchema),
  followUpDate: nullableIsoDate,
  status: hrCoachingStatusSchema,
  visibility: hrVisibilitySchema,
  acknowledgedAt: nullableInstant,
  employeeComment: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrCoachingLogSchema = hrCoachingLogRowSchema.extend({
  employeeName: z.string(),
  companyName: nullableString,
});

// ── evaluations ─────────────────────────────────────────────────────────────

const hrEvaluationCriterionResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: nullableString.optional(),
  weight: z.number(),
  maxScore: z.number(),
});

const hrEvaluationScoreResponseSchema = z.object({
  criterionId: z.string(),
  score: z.number(),
  comment: nullableString.optional(),
});

export const hrEvaluationFormSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableString,
  criteria: z.array(hrEvaluationCriterionResponseSchema),
  isActive: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrEvaluationRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  formId: z.string(),
  companyId: nullableString,
  evaluatorUserId: nullableString,
  evaluatorName: nullableString,
  periodStart: nullableIsoDate,
  periodEnd: nullableIsoDate,
  criteria: z.array(hrEvaluationCriterionResponseSchema),
  scores: z.array(hrEvaluationScoreResponseSchema),
  overallScore: z.number().nullable(),
  summary: nullableString,
  status: hrEvaluationStatusSchema,
  sharedWithClient: z.boolean(),
  submittedAt: nullableInstant,
  acknowledgedAt: nullableInstant,
  employeeComment: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrEvaluationSchema = hrEvaluationRowSchema.extend({
  employeeName: z.string(),
  formName: nullableString,
  companyName: nullableString,
});

// ── KPIs and milestones ─────────────────────────────────────────────────────

export const hrKpiDefinitionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableString,
  unit: hrKpiUnitSchema,
  direction: hrKpiDirectionSchema,
  target: z.number().nullable(),
  companyId: nullableString,
  isActive: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});

export const hrKpiDefinitionSchema = hrKpiDefinitionRowSchema.extend({ companyName: nullableString });

export const hrKpiValueRowSchema = z.object({
  id: z.string(),
  kpiId: z.string(),
  employeeId: z.string(),
  companyId: nullableString,
  periodStart: isoDate,
  periodEnd: isoDate,
  value: z.number(),
  source: z.string(),
  sharedWithClient: z.boolean(),
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

export const hrKpiValueSchema = hrKpiValueRowSchema.extend({
  employeeName: z.string(),
  kpiName: z.string(),
  unit: hrKpiUnitSchema,
  direction: hrKpiDirectionSchema,
  target: z.number().nullable(),
  onTarget: z.boolean().nullable(),
});

export const hrMilestoneRowSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: nullableString,
  title: z.string(),
  description: nullableString,
  type: hrMilestoneTypeSchema,
  status: hrMilestoneStatusSchema,
  dueDate: nullableIsoDate,
  achievedAt: nullableIsoDate,
  sharedWithClient: z.boolean(),
  createdBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

export const hrMilestoneSchema = hrMilestoneRowSchema.extend({
  employeeName: z.string(),
  companyName: nullableString,
});

// ── settings and dashboard ──────────────────────────────────────────────────

export const hrSettingsSchema = z.object({
  id: z.string(),
  employeeSelfClockIn: z.boolean(),
  clockInRequiresLocation: z.boolean(),
  employeeLeaveRequests: z.boolean(),
  employeeDeclarations: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});

export const hrDashboardSchema = z.object({
  headcount: z.object({ total: count, byStatus: z.record(count) }),
  today: z.object({
    date: isoDate,
    clockedIn: count,
    byStatus: z.record(count),
    onLeave: z.array(
      z.object({ employeeId: z.string(), employeeName: z.string(), leaveTypeName: nullableString, endDate: isoDate }),
    ),
  }),
  lifecycle: z.object({
    openTasks: count,
    overdueTasks: count,
    upcomingStarts: z.array(
      z.object({
        id: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        preferredName: nullableString,
        displayName: z.string(),
        jobTitle: nullableString,
        startDate: nullableIsoDate,
        status: hrEmployeeStatusSchema,
      }),
    ),
  }),
  pendingLeaveRequests: count,
  coachingFollowUpsDue: count,
  evaluations: z.object({
    averageScore90d: z.number().nullable(),
    recent: z.array(
      z.object({
        id: z.string(),
        employeeId: z.string(),
        employeeName: z.string(),
        overallScore: z.number().nullable(),
        status: hrEvaluationStatusSchema,
        submittedAt: nullableInstant,
      }),
    ),
  }),
  clients: z.array(hrClientAccountSchema),
});

// ── My HR (/me) ─────────────────────────────────────────────────────────────

export const hrSelfProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: nullableString,
  avatarUrl: nullableString,
  jobTitle: nullableString,
  employeeNumber: nullableString,
  status: hrEmployeeStatusSchema,
  employmentType: hrEmploymentTypeSchema,
  startDate: nullableIsoDate,
  location: nullableString,
  departmentName: nullableString,
  manager: z.object({ displayName: z.string(), email: z.string() }).nullable(),
  clients: z.array(hrClientRefSchema),
});

/** `GET /me`. */
export const hrSelfSchema = z.object({
  employee: hrSelfProfileSchema.nullable(),
  features: z.object({
    selfClockIn: z.boolean(),
    clockInRequiresLocation: z.boolean(),
    leaveRequests: z.boolean(),
    declarations: z.boolean(),
  }),
});

/** `GET /me/overview`. */
export const hrSelfOverviewSchema = z.object({
  profile: hrSelfProfileSchema,
  clock: z.object({ clockedIn: z.boolean(), since: nullableInstant, shiftId: nullableString }),
  upcomingShifts: z.array(z.object({ id: z.string(), startsAt: instant, endsAt: instant, companyName: nullableString })),
  leaveBalances: z.array(hrLeaveBalanceSchema),
  openTasks: count,
  toAcknowledge: z.object({ coaching: count, evaluations: count }),
  latestEvaluation: z
    .object({ id: z.string(), overallScore: z.number().nullable(), formName: nullableString, submittedAt: nullableInstant })
    .nullable(),
  milestones: z.object({ achieved: count, open: count }),
  unreadAnnouncements: count,
  openShifts: count,
});

/** A shift request as the employee sees it (`toSelfShiftRequest`). */
export const hrSelfShiftRequestSchema = z.object({
  id: z.string(),
  openShiftId: nullableString,
  startsAt: instant,
  endsAt: instant,
  workType: nullableString,
  note: nullableString,
  status: hrShiftRequestStatusSchema,
  reviewedAt: nullableInstant,
  reviewedByName: nullableString,
  reviewNote: nullableString,
  createdAt: instant,
});

const hourlyPay = { hourlyRate: z.number().nullable(), currency: nullableString };

/** `GET /me/attendance`. */
export const hrSelfAttendanceSchema = z.object({
  records: z.array(
    z.object({
      ...hourlyPay,
      id: z.string(),
      date: isoDate,
      clockIn: nullableInstant,
      clockOut: nullableInstant,
      breakMinutes: z.number().int(),
      workedMinutes: z.number().int().nullable(),
      lateMinutes: z.number().int(),
      status: hrAttendanceStatusSchema,
      source: hrAttendanceSourceSchema,
      approved: z.boolean(),
      companyName: nullableString,
      shiftId: nullableString,
      notes: nullableString,
    }),
  ),
  shifts: z.array(
    z.object({
      ...hourlyPay,
      id: z.string(),
      startsAt: instant,
      endsAt: instant,
      workType: nullableString,
      breakStartsAt: nullableInstant,
      breakEndsAt: nullableInstant,
      companyName: nullableString,
      notes: nullableString,
    }),
  ),
  requests: z.array(hrSelfShiftRequestSchema),
});

export const hrSelfOpenShiftSchema = z.object({
  id: z.string(),
  startsAt: instant,
  endsAt: instant,
  workType: nullableString,
  breakStartsAt: nullableInstant,
  breakEndsAt: nullableInstant,
  notes: nullableString,
  companyName: nullableString,
  departmentName: nullableString,
  spots: z.number().int().positive(),
  spotsLeft: count,
  myRequest: z.object({ id: z.string(), status: hrShiftRequestStatusSchema, reviewNote: nullableString }).nullable(),
});

/** `GET /me/announcements`. */
export const hrSelfAnnouncementsSchema = z.object({
  announcements: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      pinned: z.boolean(),
      publishedAt: instant,
      updatedAt: instant,
      createdByName: nullableString,
      readAt: nullableInstant,
    }),
  ),
  unread: count,
});

/** `POST /me/announcements/:announcementId/read`. */
export const hrSelfAnnouncementReadSchema = z.object({ id: z.string(), readAt: instant });

/** `POST /me/clock`. */
export const hrSelfClockResultSchema = z.object({
  id: z.string(),
  date: isoDate,
  clockIn: nullableInstant,
  clockOut: nullableInstant,
  status: hrAttendanceStatusSchema,
  workedMinutes: z.number().int().nullable(),
  lateMinutes: z.number().int(),
});

/** `GET /me/leave`. */
export const hrSelfLeaveSchema = z.object({
  types: z.array(z.object({ id: z.string(), name: z.string(), color: nullableString, requiresApproval: z.boolean() })),
  balances: z.array(hrLeaveBalanceSchema),
  requests: z.array(
    z.object({
      id: z.string(),
      leaveTypeId: z.string(),
      leaveTypeName: nullableString,
      leaveTypeColor: nullableString,
      startDate: isoDate,
      endDate: isoDate,
      days: z.number(),
      reason: nullableString,
      status: hrLeaveStatusSchema,
      reviewNote: nullableString,
      reviewedAt: nullableInstant,
      reviewedByName: nullableString,
      createdAt: instant,
    }),
  ),
});

/** `GET /me/declarations`. */
export const hrSelfDeclarationsSchema = z.object({
  declarations: z.array(
    z.object({
      id: z.string(),
      expenseDate: isoDate,
      category: hrDeclarationCategorySchema,
      description: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: hrDeclarationStatusSchema,
      hasReceipt: z.boolean(),
      receiptFileName: nullableString,
      reviewNote: nullableString,
      reviewedAt: nullableInstant,
      paidAt: nullableInstant,
      createdAt: instant,
    }),
  ),
  open: z.array(z.object({ currency: z.string(), pending: z.number(), approved: z.number() })),
});

const hrSelfAbsenceSchema = z.object({
  id: z.string(),
  startDate: isoDate,
  endDate: nullableIsoDate,
  firstDay: hrAbsenceFirstDaySchema,
  note: nullableString,
  status: hrAbsenceStatusSchema,
  days: z.number(),
  createdAt: instant,
});

/** `GET /me/absences`. */
export const hrSelfAbsencesSchema = z.object({
  current: hrSelfAbsenceSchema.nullable(),
  history: z.array(hrSelfAbsenceSchema),
});

export const hrSelfTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableString,
  dueDate: nullableIsoDate,
  assigneeRole: hrAssigneeRoleSchema,
  completedAt: nullableInstant,
  canComplete: z.boolean(),
  checklistName: z.string(),
  checklistKind: hrChecklistKindSchema,
});

/** `POST /me/tasks/:taskId/complete`. */
export const hrSelfTaskCompletedSchema = z.object({ ok: z.literal(true), checklistCompleted: z.boolean() });

export const hrSelfCoachingLogSchema = z.object({
  id: z.string(),
  sessionDate: isoDate,
  category: hrCoachingCategorySchema,
  topic: z.string(),
  notes: nullableString,
  actionItems: z.array(hrCoachingActionItemResponseSchema),
  followUpDate: nullableIsoDate,
  status: hrCoachingStatusSchema,
  coachName: nullableString,
  acknowledgedAt: nullableInstant,
  employeeComment: nullableString,
});

export const hrSelfEvaluationSchema = z.object({
  id: z.string(),
  formName: nullableString,
  periodStart: nullableIsoDate,
  periodEnd: nullableIsoDate,
  criteria: z.array(hrEvaluationCriterionResponseSchema),
  scores: z.array(hrEvaluationScoreResponseSchema),
  overallScore: z.number().nullable(),
  summary: nullableString,
  status: hrEvaluationStatusSchema,
  evaluatorName: nullableString,
  submittedAt: nullableInstant,
  acknowledgedAt: nullableInstant,
  employeeComment: nullableString,
});

/** `POST /me/coaching/:id/acknowledge` and `/me/evaluations/:id/acknowledge`. */
export const hrSelfAcknowledgeResultSchema = z.object({
  id: z.string(),
  acknowledgedAt: nullableInstant,
  status: z.string(),
});

/** `GET /me/performance`. */
export const hrSelfPerformanceSchema = z.object({
  kpis: z.array(
    z.object({
      id: z.string(),
      kpiId: z.string(),
      kpiName: z.string(),
      unit: hrKpiUnitSchema,
      direction: hrKpiDirectionSchema,
      target: z.number().nullable(),
      value: z.number(),
      onTarget: z.boolean().nullable(),
      periodStart: isoDate,
      periodEnd: isoDate,
    }),
  ),
  milestones: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: nullableString,
      type: hrMilestoneTypeSchema,
      status: hrMilestoneStatusSchema,
      dueDate: nullableIsoDate,
      achievedAt: nullableIsoDate,
      companyName: nullableString,
    }),
  ),
});
