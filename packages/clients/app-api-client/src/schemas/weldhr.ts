/**
 * WeldHR request schemas — shared by app-api (validation) and the platform
 * (form typing). Zod v3.
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const id = z.string().min(1).max(30);
const shortText = (max: number) => z.string().trim().max(max);
const color = z.string().max(20).regex(/^#?[0-9a-zA-Z]{3,8}$/).nullable().optional();

export const hrEmploymentTypeSchema = z.enum(['full_time', 'part_time', 'contractor', 'intern', 'temporary']);
export const hrEmployeeStatusSchema = z.enum(['onboarding', 'active', 'on_leave', 'offboarding', 'terminated']);
export const hrChecklistKindSchema = z.enum(['onboarding', 'offboarding']);
export const hrAssigneeRoleSchema = z.enum(['hr', 'manager', 'it', 'employee', 'other']);
export const hrAttendanceStatusSchema = z.enum(['present', 'late', 'absent', 'excused', 'remote', 'half_day']);
export const hrLeaveStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
export const hrCoachingCategorySchema = z.enum([
  'performance',
  'quality',
  'behavior',
  'attendance',
  'development',
  'recognition',
]);
export const hrCoachingStatusSchema = z.enum(['open', 'acknowledged', 'closed']);
export const hrVisibilitySchema = z.enum(['internal', 'employee', 'client']);
export const hrEvaluationStatusSchema = z.enum(['draft', 'submitted', 'acknowledged']);
export const hrKpiUnitSchema = z.enum(['number', 'percent', 'seconds', 'minutes', 'currency']);
export const hrKpiDirectionSchema = z.enum(['higher_better', 'lower_better']);
export const hrMilestoneTypeSchema = z.enum(['goal', 'milestone', 'certification']);
export const hrMilestoneStatusSchema = z.enum(['planned', 'in_progress', 'achieved', 'missed']);
export const hrPortalAccessKindSchema = z.enum(['employee', 'client']);

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export const createHrDepartmentSchema = z.object({
  name: shortText(120).min(1),
  description: z.string().max(2000).nullable().optional(),
  parentId: id.nullable().optional(),
  headEmployeeId: id.nullable().optional(),
  color,
});
export const updateHrDepartmentSchema = createHrDepartmentSchema.partial();

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const hrEmployeeSensitiveSchema = z.object({
  dateOfBirth: isoDate.nullable().optional(),
  nationalId: shortText(100).nullable().optional(),
  taxId: shortText(100).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  personalEmail: z.string().email().max(255).nullable().optional(),
  personalPhone: shortText(50).nullable().optional(),
  emergencyContactName: shortText(255).nullable().optional(),
  emergencyContactPhone: shortText(50).nullable().optional(),
  emergencyContactRelation: shortText(100).nullable().optional(),
  bankAccount: shortText(100).nullable().optional(),
  salaryAmount: z.number().nonnegative().nullable().optional(),
  salaryCurrency: z.string().length(3).nullable().optional(),
  salaryPeriod: z.enum(['hour', 'month', 'year']).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export const createHrEmployeeSchema = z.object({
  employeeNumber: shortText(50).nullable().optional(),
  firstName: shortText(120).min(1),
  lastName: shortText(120).min(1),
  preferredName: shortText(120).nullable().optional(),
  email: z.string().trim().email().max(255),
  phone: shortText(50).nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  pronouns: shortText(40).nullable().optional(),
  jobTitle: shortText(160).nullable().optional(),
  departmentId: id.nullable().optional(),
  managerId: id.nullable().optional(),
  userId: z.string().max(255).nullable().optional(),
  employmentType: hrEmploymentTypeSchema.optional(),
  status: hrEmployeeStatusSchema.optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  probationEndDate: isoDate.nullable().optional(),
  location: shortText(160).nullable().optional(),
  timezone: shortText(60).nullable().optional(),
  weeklyHours: z.number().min(0).max(168).nullable().optional(),
  customFields: z.record(z.unknown()).optional(),
  /** Requires `employees:sensitive`; ignored with a 403 otherwise. */
  sensitive: hrEmployeeSensitiveSchema.optional(),
  /** Start this onboarding template right away. */
  onboardingTemplateId: id.optional(),
});
export const updateHrEmployeeSchema = createHrEmployeeSchema
  .omit({ onboardingTemplateId: true })
  .partial();

export const listHrEmployeesQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  departmentId: id.optional(),
  managerId: id.optional(),
  companyId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(60).optional(),
});

// ---------------------------------------------------------------------------
// Client assignments
// ---------------------------------------------------------------------------

export const createHrAssignmentSchema = z.object({
  employeeId: id,
  companyId: id,
  role: shortText(120).nullable().optional(),
  allocationPercent: z.number().min(0).max(100).optional(),
  isPrimary: z.boolean().optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const updateHrAssignmentSchema = createHrAssignmentSchema
  .omit({ employeeId: true, companyId: true })
  .partial();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const hrChecklistTemplateItemSchema = z.object({
  id: z.string().min(1).max(40),
  title: shortText(255).min(1),
  description: z.string().max(2000).nullable().optional(),
  assigneeRole: hrAssigneeRoleSchema,
  dueOffsetDays: z.number().int().min(-365).max(365),
  visibleToEmployee: z.boolean(),
});

export const createHrChecklistTemplateSchema = z.object({
  name: shortText(160).min(1),
  description: z.string().max(2000).nullable().optional(),
  kind: hrChecklistKindSchema,
  departmentId: id.nullable().optional(),
  items: z.array(hrChecklistTemplateItemSchema).max(200),
  isDefault: z.boolean().optional(),
});
export const updateHrChecklistTemplateSchema = createHrChecklistTemplateSchema.partial();

export const startHrChecklistSchema = z.object({
  templateId: id,
  /** Anchor for due dates. Defaults to start date (onboarding) or end date / today (offboarding). */
  anchorDate: isoDate.optional(),
});

export const createHrChecklistTaskSchema = z.object({
  title: shortText(255).min(1),
  description: z.string().max(2000).nullable().optional(),
  assigneeRole: hrAssigneeRoleSchema.optional(),
  assigneeUserId: z.string().max(255).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  visibleToEmployee: z.boolean().optional(),
});
export const updateHrChecklistTaskSchema = createHrChecklistTaskSchema.partial().extend({
  completed: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Shifts & attendance
// ---------------------------------------------------------------------------

export const createHrShiftSchema = z.object({
  employeeId: id,
  companyId: id.nullable().optional(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  notes: z.string().max(1000).nullable().optional(),
});
export const updateHrShiftSchema = createHrShiftSchema.omit({ employeeId: true }).partial();

export const createHrAttendanceSchema = z.object({
  employeeId: id,
  companyId: id.nullable().optional(),
  date: isoDate,
  clockIn: isoDateTime.nullable().optional(),
  clockOut: isoDateTime.nullable().optional(),
  breakMinutes: z.number().int().min(0).max(1440).optional(),
  status: hrAttendanceStatusSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const updateHrAttendanceSchema = createHrAttendanceSchema.omit({ employeeId: true }).partial();

export const importHrAttendanceSchema = z.object({
  /** Rows keyed by employee email or employee number. */
  rows: z
    .array(
      z.object({
        employee: z.string().min(1).max(255),
        date: isoDate,
        clockIn: isoDateTime.nullable().optional(),
        clockOut: isoDateTime.nullable().optional(),
        breakMinutes: z.number().int().min(0).max(1440).optional(),
        status: hrAttendanceStatusSchema.optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export const createHrLeaveTypeSchema = z.object({
  name: shortText(120).min(1),
  color,
  isPaid: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  defaultAllowanceDays: z.number().min(0).max(366).nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateHrLeaveTypeSchema = createHrLeaveTypeSchema.partial();

export const setHrLeaveAllowanceSchema = z.object({
  employeeId: id,
  leaveTypeId: id,
  year: z.number().int().min(2000).max(2100),
  days: z.number().min(0).max(366),
});

export const createHrLeaveRequestSchema = z.object({
  employeeId: id,
  leaveTypeId: id,
  startDate: isoDate,
  endDate: isoDate,
  /** Defaults to working days (Mon–Fri) in the range. */
  days: z.number().min(0.5).max(366).optional(),
  reason: z.string().max(2000).nullable().optional(),
});

export const reviewHrLeaveRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

export const hrCoachingActionItemSchema = z.object({
  id: z.string().min(1).max(40),
  text: shortText(500).min(1),
  done: z.boolean(),
});

export const createHrCoachingLogSchema = z.object({
  employeeId: id,
  companyId: id.nullable().optional(),
  coachUserId: z.string().max(255).nullable().optional(),
  coachName: shortText(255).nullable().optional(),
  sessionDate: isoDate,
  category: hrCoachingCategorySchema.optional(),
  topic: shortText(255).min(1),
  notes: z.string().max(20000).nullable().optional(),
  actionItems: z.array(hrCoachingActionItemSchema).max(50).optional(),
  followUpDate: isoDate.nullable().optional(),
  status: hrCoachingStatusSchema.optional(),
  visibility: hrVisibilitySchema.optional(),
});
export const updateHrCoachingLogSchema = createHrCoachingLogSchema.omit({ employeeId: true }).partial();

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export const hrEvaluationCriterionSchema = z.object({
  id: z.string().min(1).max(40),
  label: shortText(200).min(1),
  description: z.string().max(1000).nullable().optional(),
  weight: z.number().min(0).max(100),
  maxScore: z.number().min(1).max(100),
});

export const createHrEvaluationFormSchema = z.object({
  name: shortText(160).min(1),
  description: z.string().max(2000).nullable().optional(),
  criteria: z.array(hrEvaluationCriterionSchema).min(1).max(50),
  isActive: z.boolean().optional(),
});
export const updateHrEvaluationFormSchema = createHrEvaluationFormSchema.partial();

export const hrEvaluationScoreSchema = z.object({
  criterionId: z.string().min(1).max(40),
  score: z.number().min(0).max(100),
  comment: z.string().max(2000).nullable().optional(),
});

export const createHrEvaluationSchema = z.object({
  employeeId: id,
  formId: id,
  companyId: id.nullable().optional(),
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
  scores: z.array(hrEvaluationScoreSchema).max(50).optional(),
  summary: z.string().max(20000).nullable().optional(),
  sharedWithClient: z.boolean().optional(),
  /** Submit straight away instead of saving a draft. */
  submit: z.boolean().optional(),
});
export const updateHrEvaluationSchema = createHrEvaluationSchema
  .omit({ employeeId: true, formId: true })
  .partial();

// ---------------------------------------------------------------------------
// KPIs & milestones
// ---------------------------------------------------------------------------

export const createHrKpiDefinitionSchema = z.object({
  name: shortText(120).min(1),
  description: z.string().max(2000).nullable().optional(),
  unit: hrKpiUnitSchema.optional(),
  direction: hrKpiDirectionSchema.optional(),
  target: z.number().nullable().optional(),
  companyId: id.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateHrKpiDefinitionSchema = createHrKpiDefinitionSchema.partial();

export const createHrKpiValueSchema = z.object({
  kpiId: id,
  employeeId: id,
  companyId: id.nullable().optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  value: z.number(),
  sharedWithClient: z.boolean().optional(),
});
export const updateHrKpiValueSchema = createHrKpiValueSchema
  .omit({ kpiId: true, employeeId: true })
  .partial();

export const importHrKpiValuesSchema = z.object({
  kpiId: id,
  periodStart: isoDate,
  periodEnd: isoDate,
  sharedWithClient: z.boolean().optional(),
  rows: z
    .array(
      z.object({
        employee: z.string().min(1).max(255),
        value: z.number(),
        companyId: id.nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export const createHrMilestoneSchema = z.object({
  employeeId: id,
  companyId: id.nullable().optional(),
  title: shortText(255).min(1),
  description: z.string().max(5000).nullable().optional(),
  type: hrMilestoneTypeSchema.optional(),
  status: hrMilestoneStatusSchema.optional(),
  dueDate: isoDate.nullable().optional(),
  achievedAt: isoDate.nullable().optional(),
  sharedWithClient: z.boolean().optional(),
});
export const updateHrMilestoneSchema = createHrMilestoneSchema.omit({ employeeId: true }).partial();

// ---------------------------------------------------------------------------
// Portal (back office)
// ---------------------------------------------------------------------------

export const updateHrPortalSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  employeePortalEnabled: z.boolean().optional(),
  clientPortalEnabled: z.boolean().optional(),
  displayName: shortText(255).nullable().optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  faviconUrl: z.string().url().max(500).nullable().optional(),
  primaryColor: color,
  accentColor: color,
  welcomeMessage: z.string().max(2000).nullable().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  hideWeldsuiteBranding: z.boolean().optional(),
  customDomain: z
    .string()
    .trim()
    .toLowerCase()
    .max(255)
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a hostname like portal.example.com')
    .nullable()
    .optional(),
  clientCanSeeIndividualScores: z.boolean().optional(),
  employeeSelfClockIn: z.boolean().optional(),
  employeeLeaveRequests: z.boolean().optional(),
});

export const inviteHrPortalAccessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), employeeId: id }),
  z.object({ kind: z.literal('client'), personId: id, companyId: id }),
]);

// ---------------------------------------------------------------------------
// Public workforce portal
// ---------------------------------------------------------------------------

export const hrPortalAuthRequestSchema = z.object({
  email: z.string().trim().email().max(255),
});

export const hrPortalAuthVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  otp: z.string().min(4).max(12),
});

export const hrPortalSelectAccessSchema = z.object({
  pickerToken: z.string().min(1).max(200),
  accessId: id,
});

export const hrPortalClockSchema = z.object({
  action: z.enum(['in', 'out']),
});

export const hrPortalLeaveRequestSchema = z.object({
  leaveTypeId: id,
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().max(2000).nullable().optional(),
});

export const hrPortalAcknowledgeSchema = z.object({
  comment: z.string().max(5000).nullable().optional(),
});

export const hrPortalClientRequestSchema = z.object({
  subject: shortText(255).min(1),
  message: z.string().trim().min(1).max(20000),
});

export type CreateHrEmployeeInput = z.infer<typeof createHrEmployeeSchema>;
export type UpdateHrEmployeeInput = z.infer<typeof updateHrEmployeeSchema>;
export type HrEmployeeSensitiveInput = z.infer<typeof hrEmployeeSensitiveSchema>;
export type CreateHrAssignmentInput = z.infer<typeof createHrAssignmentSchema>;
export type UpdateHrAssignmentInput = z.infer<typeof updateHrAssignmentSchema>;
export type CreateHrChecklistTemplateInput = z.infer<typeof createHrChecklistTemplateSchema>;
export type HrChecklistTemplateItemInput = z.infer<typeof hrChecklistTemplateItemSchema>;
export type CreateHrChecklistTaskInput = z.infer<typeof createHrChecklistTaskSchema>;
export type UpdateHrChecklistTaskInput = z.infer<typeof updateHrChecklistTaskSchema>;
export type CreateHrShiftInput = z.infer<typeof createHrShiftSchema>;
export type CreateHrAttendanceInput = z.infer<typeof createHrAttendanceSchema>;
export type UpdateHrAttendanceInput = z.infer<typeof updateHrAttendanceSchema>;
export type ImportHrAttendanceInput = z.infer<typeof importHrAttendanceSchema>;
export type CreateHrLeaveTypeInput = z.infer<typeof createHrLeaveTypeSchema>;
export type CreateHrLeaveRequestInput = z.infer<typeof createHrLeaveRequestSchema>;
export type ReviewHrLeaveRequestInput = z.infer<typeof reviewHrLeaveRequestSchema>;
export type CreateHrCoachingLogInput = z.infer<typeof createHrCoachingLogSchema>;
export type UpdateHrCoachingLogInput = z.infer<typeof updateHrCoachingLogSchema>;
export type HrCoachingActionItemInput = z.infer<typeof hrCoachingActionItemSchema>;
export type CreateHrEvaluationFormInput = z.infer<typeof createHrEvaluationFormSchema>;
export type HrEvaluationCriterionInput = z.infer<typeof hrEvaluationCriterionSchema>;
export type CreateHrEvaluationInput = z.infer<typeof createHrEvaluationSchema>;
export type UpdateHrEvaluationInput = z.infer<typeof updateHrEvaluationSchema>;
export type CreateHrKpiDefinitionInput = z.infer<typeof createHrKpiDefinitionSchema>;
export type CreateHrKpiValueInput = z.infer<typeof createHrKpiValueSchema>;
export type ImportHrKpiValuesInput = z.infer<typeof importHrKpiValuesSchema>;
export type CreateHrMilestoneInput = z.infer<typeof createHrMilestoneSchema>;
export type UpdateHrMilestoneInput = z.infer<typeof updateHrMilestoneSchema>;
export type UpdateHrPortalSettingsInput = z.infer<typeof updateHrPortalSettingsSchema>;
export type InviteHrPortalAccessInput = z.infer<typeof inviteHrPortalAccessSchema>;
export type CreateHrDepartmentInput = z.infer<typeof createHrDepartmentSchema>;
