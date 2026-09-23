/**
 * WeldHR — employee operations and the workforce portal. Tenant DB.
 *
 * The spine of the model is employee ↔ client account: a client account is a
 * CRM `companies` row, and `hr_client_assignments` says who works on it. The
 * workforce portal uses that same table to decide what a client may see, so an
 * assignment is end-dated rather than deleted — history is what a client's
 * "team over time" view reads.
 *
 * Personal data that is not needed to run the team (date of birth, national id,
 * home address, emergency contact, pay) lives in `sensitive_encrypted`, one
 * AES-GCM blob encrypted with the worker's DATABASE_ENCRYPTION_KEY. It is only
 * decrypted for callers holding `employees:sensitive`, and every such read is
 * written to `hr_audit_events`.
 *
 * Everything a client can see is opt-in per record (`shared_with_client`,
 * coaching `visibility = 'client'`). The default is internal.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  date,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export type HrEmploymentType = 'full_time' | 'part_time' | 'contractor' | 'intern' | 'temporary';
export type HrEmployeeStatus = 'onboarding' | 'active' | 'on_leave' | 'offboarding' | 'terminated';

/** Decrypted shape of `hr_employees.sensitive_encrypted`. */
export interface HrEmployeeSensitive {
  dateOfBirth?: string | null;
  nationalId?: string | null;
  taxId?: string | null;
  address?: string | null;
  personalEmail?: string | null;
  personalPhone?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactRelation?: string | null;
  bankAccount?: string | null;
  salaryAmount?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: 'hour' | 'month' | 'year' | null;
  notes?: string | null;
}

export type HrChecklistKind = 'onboarding' | 'offboarding';
export type HrChecklistStatus = 'in_progress' | 'completed' | 'cancelled';
export type HrAssigneeRole = 'hr' | 'manager' | 'it' | 'employee' | 'other';

export interface HrChecklistTemplateItem {
  id: string;
  title: string;
  description?: string | null;
  assigneeRole: HrAssigneeRole;
  /** Days relative to the employee's start date (onboarding) or end date (offboarding). */
  dueOffsetDays: number;
  visibleToEmployee: boolean;
}

export type HrAttendanceStatus = 'present' | 'late' | 'absent' | 'excused' | 'remote' | 'half_day';
export type HrAttendanceSource = 'portal' | 'manual' | 'import' | 'api';

export type HrLeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type HrCoachingCategory =
  | 'performance'
  | 'quality'
  | 'behavior'
  | 'attendance'
  | 'development'
  | 'recognition';
export type HrCoachingStatus = 'open' | 'acknowledged' | 'closed';
export type HrVisibility = 'internal' | 'employee' | 'client';

export interface HrCoachingActionItem {
  id: string;
  text: string;
  done: boolean;
}

export interface HrEvaluationCriterion {
  id: string;
  label: string;
  description?: string | null;
  /** Relative weight; the overall score is the weighted mean of criterion %. */
  weight: number;
  maxScore: number;
}

export interface HrEvaluationScore {
  criterionId: string;
  score: number;
  comment?: string | null;
}

export type HrEvaluationStatus = 'draft' | 'submitted' | 'acknowledged';

export type HrKpiUnit = 'number' | 'percent' | 'seconds' | 'minutes' | 'currency';
export type HrKpiDirection = 'higher_better' | 'lower_better';

export type HrMilestoneType = 'goal' | 'milestone' | 'certification';
export type HrMilestoneStatus = 'planned' | 'in_progress' | 'achieved' | 'missed';

export type HrPortalAccessKind = 'employee' | 'client';
export type HrPortalAccessStatus = 'invited' | 'active' | 'revoked';

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export const hrDepartments = pgTable('hr_departments', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  parentId: varchar('parent_id', { length: 30 }),
  headEmployeeId: varchar('head_employee_id', { length: 30 }),
  color: varchar('color', { length: 20 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_departments_parent_idx').on(table.parentId),
]);

export const hrEmployees = pgTable('hr_employees', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeNumber: varchar('employee_number', { length: 50 }),

  firstName: varchar('first_name', { length: 120 }).notNull(),
  lastName: varchar('last_name', { length: 120 }).notNull(),
  preferredName: varchar('preferred_name', { length: 120 }),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  pronouns: varchar('pronouns', { length: 40 }),

  jobTitle: varchar('job_title', { length: 160 }),
  departmentId: varchar('department_id', { length: 30 }),
  managerId: varchar('manager_id', { length: 30 }),
  /** Clerk user id when the employee is also a workspace member. */
  userId: varchar('user_id', { length: 255 }),

  employmentType: varchar('employment_type', { length: 20 }).notNull().default('full_time'),
  status: varchar('status', { length: 20 }).notNull().default('onboarding'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  probationEndDate: date('probation_end_date'),
  location: varchar('location', { length: 160 }),
  timezone: varchar('timezone', { length: 60 }),
  weeklyHours: doublePrecision('weekly_hours'),

  /** AES-GCM blob of `HrEmployeeSensitive`. Never returned without `employees:sensitive`. */
  sensitiveEncrypted: text('sensitive_encrypted'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_employees_status_idx').on(table.status),
  index('hr_employees_department_idx').on(table.departmentId),
  index('hr_employees_manager_idx').on(table.managerId),
  index('hr_employees_email_idx').on(table.email),
  index('hr_employees_user_idx').on(table.userId),
  index('hr_employees_created_idx').on(table.createdAt, table.id),
]);

/** Employee ↔ client account (CRM company). End-dated, never deleted. */
export const hrClientAssignments = pgTable('hr_client_assignments', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }).notNull(),
  role: varchar('role', { length: 120 }),
  allocationPercent: doublePrecision('allocation_percent').notNull().default(100),
  isPrimary: boolean('is_primary').notNull().default(false),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_client_assignments_employee_idx').on(table.employeeId),
  index('hr_client_assignments_company_idx').on(table.companyId),
]);

// ---------------------------------------------------------------------------
// Lifecycle — onboarding / offboarding
// ---------------------------------------------------------------------------

export const hrChecklistTemplates = pgTable('hr_checklist_templates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  kind: varchar('kind', { length: 20 }).notNull().default('onboarding'),
  departmentId: varchar('department_id', { length: 30 }),
  items: jsonb('items').$type<HrChecklistTemplateItem[]>().notNull().default([]),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_checklist_templates_kind_idx').on(table.kind),
]);

export const hrChecklists = pgTable('hr_checklists', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  templateId: varchar('template_id', { length: 30 }),
  kind: varchar('kind', { length: 20 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('in_progress'),
  startedBy: varchar('started_by', { length: 255 }),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_checklists_employee_idx').on(table.employeeId),
  index('hr_checklists_status_idx').on(table.status),
]);

export const hrChecklistTasks = pgTable('hr_checklist_tasks', {
  id: varchar('id', { length: 30 }).primaryKey(),
  checklistId: varchar('checklist_id', { length: 30 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  assigneeRole: varchar('assignee_role', { length: 20 }).notNull().default('hr'),
  assigneeUserId: varchar('assignee_user_id', { length: 255 }),
  dueDate: date('due_date'),
  visibleToEmployee: boolean('visible_to_employee').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  completedAt: timestamp('completed_at'),
  /** Clerk user id, or `portal:<employeeId>` when the employee ticked it in the portal. */
  completedBy: varchar('completed_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_checklist_tasks_checklist_idx').on(table.checklistId),
  index('hr_checklist_tasks_employee_idx').on(table.employeeId),
  index('hr_checklist_tasks_due_idx').on(table.dueDate),
]);

// ---------------------------------------------------------------------------
// Time — shifts, attendance, leave
// ---------------------------------------------------------------------------

export const hrShifts = pgTable('hr_shifts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_shifts_employee_start_idx').on(table.employeeId, table.startsAt),
  index('hr_shifts_start_idx').on(table.startsAt),
]);

export const hrAttendanceRecords = pgTable('hr_attendance_records', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  shiftId: varchar('shift_id', { length: 30 }),
  date: date('date').notNull(),
  clockIn: timestamp('clock_in', { withTimezone: true }),
  clockOut: timestamp('clock_out', { withTimezone: true }),
  breakMinutes: integer('break_minutes').notNull().default(0),
  /** Worked minutes, computed on write from clock in/out minus breaks. */
  workedMinutes: integer('worked_minutes'),
  lateMinutes: integer('late_minutes').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('present'),
  source: varchar('source', { length: 20 }).notNull().default('manual'),
  notes: text('notes'),
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_attendance_employee_date_idx').on(table.employeeId, table.date),
  index('hr_attendance_date_idx').on(table.date),
  index('hr_attendance_company_idx').on(table.companyId),
]);

export const hrLeaveTypes = pgTable('hr_leave_types', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  color: varchar('color', { length: 20 }),
  isPaid: boolean('is_paid').notNull().default(true),
  requiresApproval: boolean('requires_approval').notNull().default(true),
  /** Days per calendar year. Null = unlimited (e.g. unpaid leave). */
  defaultAllowanceDays: doublePrecision('default_allowance_days'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const hrLeaveAllowances = pgTable('hr_leave_allowances', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  leaveTypeId: varchar('leave_type_id', { length: 30 }).notNull(),
  year: integer('year').notNull(),
  days: doublePrecision('days').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hr_leave_allowances_uidx').on(table.employeeId, table.leaveTypeId, table.year),
]);

export const hrLeaveRequests = pgTable('hr_leave_requests', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  leaveTypeId: varchar('leave_type_id', { length: 30 }).notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  days: doublePrecision('days').notNull(),
  reason: text('reason'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  /** Clerk user id, or `portal:<employeeId>` for a request made in the portal. */
  requestedBy: varchar('requested_by', { length: 255 }),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: timestamp('reviewed_at'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_leave_requests_employee_idx').on(table.employeeId),
  index('hr_leave_requests_status_idx').on(table.status),
  index('hr_leave_requests_start_idx').on(table.startDate),
]);

// ---------------------------------------------------------------------------
// Performance — coaching, evaluations, KPIs, milestones
// ---------------------------------------------------------------------------

export const hrCoachingLogs = pgTable('hr_coaching_logs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  coachUserId: varchar('coach_user_id', { length: 255 }),
  coachName: varchar('coach_name', { length: 255 }),
  sessionDate: date('session_date').notNull(),
  category: varchar('category', { length: 20 }).notNull().default('performance'),
  topic: varchar('topic', { length: 255 }).notNull(),
  notes: text('notes'),
  actionItems: jsonb('action_items').$type<HrCoachingActionItem[]>().notNull().default([]),
  followUpDate: date('follow_up_date'),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  visibility: varchar('visibility', { length: 20 }).notNull().default('employee'),
  acknowledgedAt: timestamp('acknowledged_at'),
  employeeComment: text('employee_comment'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_coaching_logs_employee_idx').on(table.employeeId, table.sessionDate),
  index('hr_coaching_logs_follow_up_idx').on(table.followUpDate),
  index('hr_coaching_logs_status_idx').on(table.status),
]);

export const hrEvaluationForms = pgTable('hr_evaluation_forms', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  criteria: jsonb('criteria').$type<HrEvaluationCriterion[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const hrEvaluations = pgTable('hr_evaluations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  formId: varchar('form_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  evaluatorUserId: varchar('evaluator_user_id', { length: 255 }),
  evaluatorName: varchar('evaluator_name', { length: 255 }),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  /** Snapshot of the form's criteria at scoring time, so editing a form never rescores history. */
  criteria: jsonb('criteria').$type<HrEvaluationCriterion[]>().notNull().default([]),
  scores: jsonb('scores').$type<HrEvaluationScore[]>().notNull().default([]),
  /** Weighted overall score, 0–100. */
  overallScore: doublePrecision('overall_score'),
  summary: text('summary'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  sharedWithClient: boolean('shared_with_client').notNull().default(false),
  submittedAt: timestamp('submitted_at'),
  acknowledgedAt: timestamp('acknowledged_at'),
  employeeComment: text('employee_comment'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_evaluations_employee_idx').on(table.employeeId),
  index('hr_evaluations_status_idx').on(table.status),
  index('hr_evaluations_company_idx').on(table.companyId),
]);

export const hrKpiDefinitions = pgTable('hr_kpi_definitions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  unit: varchar('unit', { length: 20 }).notNull().default('number'),
  direction: varchar('direction', { length: 20 }).notNull().default('higher_better'),
  target: doublePrecision('target'),
  /** Set when the KPI belongs to one client account only. */
  companyId: varchar('company_id', { length: 30 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const hrKpiValues = pgTable('hr_kpi_values', {
  id: varchar('id', { length: 30 }).primaryKey(),
  kpiId: varchar('kpi_id', { length: 30 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  value: doublePrecision('value').notNull(),
  source: varchar('source', { length: 20 }).notNull().default('manual'),
  sharedWithClient: boolean('shared_with_client').notNull().default(false),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_kpi_values_employee_idx').on(table.employeeId, table.periodStart),
  index('hr_kpi_values_kpi_idx').on(table.kpiId, table.periodStart),
  index('hr_kpi_values_company_idx').on(table.companyId),
]);

export const hrMilestones = pgTable('hr_milestones', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 20 }).notNull().default('milestone'),
  status: varchar('status', { length: 20 }).notNull().default('planned'),
  dueDate: date('due_date'),
  achievedAt: date('achieved_at'),
  sharedWithClient: boolean('shared_with_client').notNull().default(false),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_milestones_employee_idx').on(table.employeeId),
  index('hr_milestones_company_idx').on(table.companyId),
]);

// ---------------------------------------------------------------------------
// Workforce portal
// ---------------------------------------------------------------------------

/** One row per workspace. The public portal 404s while `is_enabled` is false. */
export const hrPortalSettings = pgTable('hr_portal_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  isEnabled: boolean('is_enabled').notNull().default(false),
  employeePortalEnabled: boolean('employee_portal_enabled').notNull().default(true),
  clientPortalEnabled: boolean('client_portal_enabled').notNull().default(true),

  displayName: varchar('display_name', { length: 255 }),
  logoUrl: varchar('logo_url', { length: 500 }),
  faviconUrl: varchar('favicon_url', { length: 500 }),
  primaryColor: varchar('primary_color', { length: 20 }),
  accentColor: varchar('accent_color', { length: 20 }),
  welcomeMessage: text('welcome_message'),
  supportEmail: varchar('support_email', { length: 255 }),
  /** White-label: no WeldSuite marks in the portal or its emails. */
  hideWeldsuiteBranding: boolean('hide_weldsuite_branding').notNull().default(true),
  /** Hostname the customer points at the portal, e.g. `portal.acme-bpo.com`. */
  customDomain: varchar('custom_domain', { length: 255 }),

  /** When false, clients see team aggregates only — never a single employee's score. */
  clientCanSeeIndividualScores: boolean('client_can_see_individual_scores').notNull().default(true),
  /** Employees may clock in and out from the portal. */
  employeeSelfClockIn: boolean('employee_self_clock_in').notNull().default(true),
  /** Employees may request leave from the portal. */
  employeeLeaveRequests: boolean('employee_leave_requests').notNull().default(true),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * Who may sign in to the workforce portal. An employee grant points at an
 * `hr_employees` row; a client grant points at a CRM person at a company.
 * Revoke is a status flip, so a re-invite updates the same row.
 */
export const hrPortalAccess = pgTable('hr_portal_access', {
  id: varchar('id', { length: 30 }).primaryKey(),
  kind: varchar('kind', { length: 20 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  companyId: varchar('company_id', { length: 30 }),
  email: varchar('email', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('invited'),
  invitedBy: varchar('invited_by', { length: 255 }),
  invitedAt: timestamp('invited_at'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_portal_access_email_idx').on(table.email),
  index('hr_portal_access_employee_idx').on(table.employeeId),
  index('hr_portal_access_company_idx').on(table.companyId),
  uniqueIndex('hr_portal_access_kind_email_company_uidx').on(table.kind, table.email, table.companyId),
]);

/** Reads of sensitive data and access changes. Append-only. */
export const hrAuditEvents = pgTable('hr_audit_events', {
  id: varchar('id', { length: 30 }).primaryKey(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  action: varchar('action', { length: 60 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: varchar('ip', { length: 64 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('hr_audit_events_employee_idx').on(table.employeeId, table.createdAt),
  index('hr_audit_events_created_idx').on(table.createdAt),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type HrDepartment = typeof hrDepartments.$inferSelect;
export type HrEmployee = typeof hrEmployees.$inferSelect;
export type NewHrEmployee = typeof hrEmployees.$inferInsert;
export type HrClientAssignment = typeof hrClientAssignments.$inferSelect;
export type HrChecklistTemplate = typeof hrChecklistTemplates.$inferSelect;
export type HrChecklist = typeof hrChecklists.$inferSelect;
export type HrChecklistTask = typeof hrChecklistTasks.$inferSelect;
export type HrShift = typeof hrShifts.$inferSelect;
export type HrAttendanceRecord = typeof hrAttendanceRecords.$inferSelect;
export type HrLeaveType = typeof hrLeaveTypes.$inferSelect;
export type HrLeaveAllowance = typeof hrLeaveAllowances.$inferSelect;
export type HrLeaveRequest = typeof hrLeaveRequests.$inferSelect;
export type HrCoachingLog = typeof hrCoachingLogs.$inferSelect;
export type HrEvaluationForm = typeof hrEvaluationForms.$inferSelect;
export type HrEvaluation = typeof hrEvaluations.$inferSelect;
export type HrKpiDefinition = typeof hrKpiDefinitions.$inferSelect;
export type HrKpiValue = typeof hrKpiValues.$inferSelect;
export type HrMilestone = typeof hrMilestones.$inferSelect;
export type HrPortalSettings = typeof hrPortalSettings.$inferSelect;
export type HrPortalAccess = typeof hrPortalAccess.$inferSelect;
export type HrAuditEvent = typeof hrAuditEvents.$inferSelect;
