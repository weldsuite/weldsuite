/**
 * WeldHR — employee operations. Tenant DB.
 *
 * Every employee is a workspace member: `hr_employees.user_id` is their Clerk
 * user id, and they reach their own record through My HR. The one gap is an
 * invite that hasn't been accepted yet; such an employee is linked by email
 * once the member is active (services/weldhr/employees.ts, `linkAcceptedInvites`).
 *
 * The spine of the model is employee ↔ client account: a client account is a
 * CRM `companies` row, and `hr_client_assignments` says who works on it. An
 * assignment is end-dated rather than deleted, so a client's "team over time"
 * stays readable.
 *
 * Personal data that is not needed to run the team (date of birth, national id,
 * home address, emergency contact, pay) lives in `sensitive_encrypted`, one
 * AES-GCM blob encrypted with the worker's DATABASE_ENCRYPTION_KEY. It is only
 * decrypted for callers holding `employees:sensitive`, and every such read is
 * written to `hr_audit_events`.
 *
 * `shared_with_client` and coaching `visibility = 'client'` date from the
 * workforce portal (removed); nothing outside the back office reads them now.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  numeric,
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

  // Payroll (weldhr-payroll.ts). `nationalId` is the BSN (NL) or SSN (US).
  /** Structured salary account; `bankAccount` stays as the free-text legacy field. */
  bankAccountHolder?: string | null;
  bankIban?: string | null;
  bankBic?: string | null;
  bankRoutingNumber?: string | null;
  bankAccountNumber?: string | null;
  bankAccountType?: 'checking' | 'savings' | null;
  /** Structured home address for payroll (US state of residence, NL loonaangifte without BSN). */
  homeAddress?: {
    line1?: string | null;
    line2?: string | null;
    houseNumber?: string | null;
    houseNumberAddition?: string | null;
    postalCode?: string | null;
    city?: string | null;
    region?: string | null;
    country?: string | null;
  } | null;
  /** NL identity check before the first working day (Handboek §2.2). */
  idDocumentType?: 'passport' | 'id_card' | 'residence_permit' | 'drivers_license' | null;
  idDocumentNumber?: string | null;
  idDocumentExpiresOn?: string | null;
  idVerifiedAt?: string | null;
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
/** `portal`: the employee clocked themselves (My HR; the name is kept from the removed workforce portal). */
export type HrAttendanceSource = 'portal' | 'manual' | 'import' | 'api';

export type HrLeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** How much of the first sick day the employee was absent. */
export type HrAbsenceFirstDay = 'full' | 'half';

export type HrDeclarationCategory = 'travel' | 'meals' | 'accommodation' | 'equipment' | 'training' | 'other';
/** `paid` follows `approved`: the amount has been reimbursed to the employee. */
export type HrDeclarationStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';

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
  /**
   * `hr_work_locations` this employee may clock in at when the workspace
   * requires a location. Null or empty: any of the workspace's locations.
   */
  workLocationIds: jsonb('work_location_ids').$type<string[]>(),

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
  /**
   * The date task due dates count from: the start date (onboarding) or the
   * last working day (offboarding). An offboarding writes it to the
   * employee's end date only when it completes, so a cancelled one leaves no trace.
   */
  anchorDate: date('anchor_date'),
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
  /** What the employee is scheduled to do, e.g. "Cashier". Free text. */
  workType: varchar('work_type', { length: 100 }),
  /** Unpaid break inside the shift. Both set, or both null. */
  breakStartsAt: timestamp('break_starts_at', { withTimezone: true }),
  breakEndsAt: timestamp('break_ends_at', { withTimezone: true }),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_shifts_employee_start_idx').on(table.employeeId, table.startsAt),
  index('hr_shifts_start_idx').on(table.startsAt),
]);

/**
 * A shift nobody is on yet, posted for employees who want to work. An employee
 * signs up with a shift request pointing here (`hr_shift_requests.open_shift_id`);
 * a manager approves who gets it, and each approval puts a shift on that
 * employee's rooster, until `spots` of them are taken. How many are taken is
 * counted from those approved requests whose shift still exists, never stored.
 */
export const hrOpenShifts = pgTable('hr_open_shifts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  companyId: varchar('company_id', { length: 30 }),
  /** Only employees of this department (or one under it) see it. Null: everyone. */
  departmentId: varchar('department_id', { length: 30 }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  workType: varchar('work_type', { length: 100 }),
  breakStartsAt: timestamp('break_starts_at', { withTimezone: true }),
  breakEndsAt: timestamp('break_ends_at', { withTimezone: true }),
  notes: text('notes'),
  /** How many people the shift needs. */
  spots: integer('spots').notNull().default(1),
  /** `open` or `cancelled`. Full is derived from the approved sign-ups. */
  status: varchar('status', { length: 20 }).notNull().default('open'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_open_shifts_start_idx').on(table.startsAt),
  index('hr_open_shifts_status_idx').on(table.status),
]);

/**
 * An employee asking to work a shift (from the WeldHR app). A manager approves
 * or rejects it; approving puts the shift on the rooster and links it here.
 */
export const hrShiftRequests = pgTable('hr_shift_requests', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  /** Set when the employee signed up for an open shift; the times are copied from it. */
  openShiftId: varchar('open_shift_id', { length: 30 }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** What the employee offers to do, e.g. "Cashier". Free text. */
  workType: varchar('work_type', { length: 100 }),
  /** The employee's note to the manager. */
  note: text('note'),
  /** pending, approved, rejected or cancelled. */
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  /** The shift approving it created. */
  shiftId: varchar('shift_id', { length: 30 }),
  /** Clerk user id of whoever asked (the employee themselves). */
  requestedBy: varchar('requested_by', { length: 255 }),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: timestamp('reviewed_at'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_shift_requests_employee_start_idx').on(table.employeeId, table.startsAt),
  index('hr_shift_requests_status_idx').on(table.status),
  index('hr_shift_requests_open_shift_idx').on(table.openShiftId),
]);

/**
 * A place employees clock in at. When `hr_settings.clock_in_requires_location`
 * is on, clocking in or out needs the device within `radius_meters` of one the
 * employee is allowed (`hr_employees.work_location_ids`). Soft-deleted, so the
 * records that name one keep their name.
 */
export const hrWorkLocations = pgTable('hr_work_locations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  address: text('address'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  radiusMeters: integer('radius_meters').notNull().default(150),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

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
  /**
   * Where the employee was when clocking in and out, only recorded while the
   * workspace requires a location; the location id is the work location they
   * were at.
   */
  clockInLocationId: varchar('clock_in_location_id', { length: 30 }),
  clockInLatitude: doublePrecision('clock_in_latitude'),
  clockInLongitude: doublePrecision('clock_in_longitude'),
  clockOutLocationId: varchar('clock_out_location_id', { length: 30 }),
  clockOutLatitude: doublePrecision('clock_out_latitude'),
  clockOutLongitude: doublePrecision('clock_out_longitude'),
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
  /**
   * A request longer than what is left of the allowance: `allow` (HR and the
   * employee see a warning) or `block` (refused on request and on approval).
   */
  overAllowance: varchar('over_allowance', { length: 10 }).$type<'allow' | 'block'>().notNull().default('allow'),
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

/**
 * Sick reports. An employee reports sick from a first day and stays absent
 * until they (or HR) report recovered, so unlike a leave request the end is
 * open. The note is for practical matters (how to reach them); the nature of
 * the illness is not asked for and has no column.
 */
export const hrAbsences = pgTable('hr_absences', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  /** First sick day. */
  startDate: date('start_date').notNull(),
  /** Last sick day, inclusive. Null while the employee is still absent. */
  endDate: date('end_date'),
  /** `full` or `half`: how much of the first day the employee was absent. */
  firstDay: varchar('first_day', { length: 10 }).notNull().default('full'),
  note: text('note'),
  /** Clerk user id, or `portal:<employeeId>` for a report made in the portal. */
  reportedBy: varchar('reported_by', { length: 255 }),
  recoveredReportedBy: varchar('recovered_reported_by', { length: 255 }),
  recoveredReportedAt: timestamp('recovered_reported_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_absences_employee_start_idx').on(table.employeeId, table.startDate),
  index('hr_absences_end_idx').on(table.endDate),
]);

// ---------------------------------------------------------------------------
// Declarations — expense claims
// ---------------------------------------------------------------------------

/**
 * An expense an employee asks to be reimbursed for. The receipt is one private
 * R2 object (`receipt_file_key`, under `workspaces/<id>/hr/declarations/`); it
 * is only ever served through the permission-checked API, never by URL.
 */
export const hrDeclarations = pgTable('hr_declarations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  expenseDate: date('expense_date').notNull(),
  category: varchar('category', { length: 30 }).notNull().default('other'),
  description: text('description').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  receiptFileKey: varchar('receipt_file_key', { length: 500 }),
  receiptFileName: varchar('receipt_file_name', { length: 255 }),
  receiptContentType: varchar('receipt_content_type', { length: 120 }),
  receiptSize: integer('receipt_size'),
  /** Clerk user id, or `portal:<employeeId>` for a declaration made in the portal. */
  submittedBy: varchar('submitted_by', { length: 255 }),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: timestamp('reviewed_at'),
  reviewNote: text('review_note'),
  paidBy: varchar('paid_by', { length: 255 }),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_declarations_employee_idx').on(table.employeeId),
  index('hr_declarations_status_idx').on(table.status),
  index('hr_declarations_expense_date_idx').on(table.expenseDate),
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
// Announcements
// ---------------------------------------------------------------------------

/**
 * News from HR to employees, read in My HR and the WeldHR app. The audience is
 * everyone, or the employees of `department_ids` and the departments under them.
 */
export const hrAnnouncements = pgTable('hr_announcements', {
  id: varchar('id', { length: 30 }).primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  /** Pinned announcements stay above the rest. */
  pinned: boolean('pinned').notNull().default(false),
  /** Empty: every employee. */
  departmentIds: jsonb('department_ids').$type<string[]>().notNull().default([]),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the push notification to the audience went out; null when none was sent. */
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_announcements_published_idx').on(table.publishedAt),
]);

/** Who has read an announcement: one row per employee, written the first time they open it. */
export const hrAnnouncementReads = pgTable('hr_announcement_reads', {
  id: varchar('id', { length: 30 }).primaryKey(),
  announcementId: varchar('announcement_id', { length: 30 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hr_announcement_reads_uidx').on(table.announcementId, table.employeeId),
  index('hr_announcement_reads_employee_idx').on(table.employeeId),
]);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** One row per workspace: what employees may do for themselves in My HR. */
export const hrSettings = pgTable('hr_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  /** Employees may clock in and out from My HR. */
  employeeSelfClockIn: boolean('employee_self_clock_in').notNull().default(true),
  /** Clocking in or out yourself needs being at one of the work locations (`hr_work_locations`). */
  clockInRequiresLocation: boolean('clock_in_requires_location').notNull().default(false),
  /** Employees may request leave from My HR. */
  employeeLeaveRequests: boolean('employee_leave_requests').notNull().default(true),
  /** Employees may submit expense declarations from My HR. */
  employeeDeclarations: boolean('employee_declarations').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

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
export type HrOpenShift = typeof hrOpenShifts.$inferSelect;
export type HrShiftRequest = typeof hrShiftRequests.$inferSelect;
export type HrWorkLocation = typeof hrWorkLocations.$inferSelect;
export type HrAnnouncement = typeof hrAnnouncements.$inferSelect;
export type HrAnnouncementRead = typeof hrAnnouncementReads.$inferSelect;
export type HrAttendanceRecord = typeof hrAttendanceRecords.$inferSelect;
export type HrLeaveType = typeof hrLeaveTypes.$inferSelect;
export type HrLeaveAllowance = typeof hrLeaveAllowances.$inferSelect;
export type HrLeaveRequest = typeof hrLeaveRequests.$inferSelect;
export type HrDeclaration = typeof hrDeclarations.$inferSelect;
export type HrAbsence = typeof hrAbsences.$inferSelect;
export type HrCoachingLog = typeof hrCoachingLogs.$inferSelect;
export type HrEvaluationForm = typeof hrEvaluationForms.$inferSelect;
export type HrEvaluation = typeof hrEvaluations.$inferSelect;
export type HrKpiDefinition = typeof hrKpiDefinitions.$inferSelect;
export type HrKpiValue = typeof hrKpiValues.$inferSelect;
export type HrMilestone = typeof hrMilestones.$inferSelect;
export type HrSettings = typeof hrSettings.$inferSelect;
export type HrAuditEvent = typeof hrAuditEvents.$inferSelect;
