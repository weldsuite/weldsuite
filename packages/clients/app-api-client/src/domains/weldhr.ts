/**
 * App-API WeldHR domain client — `/api/weldhr/*`.
 *
 * Sensitive employee data only travels on `getSensitive` / `updateSensitive`,
 * which are gated on `employees:sensitive` and audited server-side. Every
 * other employee read returns the public projection (`hasSensitive` tells the
 * UI whether there is anything to reveal).
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateHrAssignmentInput,
  CreateHrAttendanceInput,
  CreateHrChecklistTaskInput,
  CreateHrChecklistTemplateInput,
  CreateHrCoachingLogInput,
  CreateHrDeclarationInput,
  CreateHrDepartmentInput,
  CreateHrEmployeeFromMemberInput,
  CreateHrEmployeeInput,
  CreateHrEvaluationFormInput,
  CreateHrEvaluationInput,
  CreateHrKpiDefinitionInput,
  CreateHrKpiValueInput,
  CreateHrLeaveRequestInput,
  CreateHrLeaveTypeInput,
  CreateHrMilestoneInput,
  CreateHrShiftInput,
  HrEmployeeSensitiveInput,
  HrSelfServiceAcknowledgeInput,
  HrSelfServiceClockInput,
  HrSelfServiceDeclarationInput,
  HrSelfServiceLeaveRequestInput,
  ImportHrAttendanceInput,
  ImportHrKpiValuesInput,
  InviteHrPortalAccessInput,
  ReviewHrDeclarationInput,
  ReviewHrLeaveRequestInput,
  UpdateHrAssignmentInput,
  UpdateHrAttendanceInput,
  UpdateHrChecklistTaskInput,
  UpdateHrCoachingLogInput,
  UpdateHrDeclarationInput,
  UpdateHrEmployeeInput,
  UpdateHrEvaluationInput,
  UpdateHrMilestoneInput,
  UpdateHrPortalSettingsInput,
} from '../schemas/weldhr';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HrEmploymentType = 'full_time' | 'part_time' | 'contractor' | 'intern' | 'temporary';
export type HrEmployeeStatus = 'onboarding' | 'active' | 'on_leave' | 'offboarding' | 'terminated';
export type HrAssigneeRole = 'hr' | 'manager' | 'it' | 'employee' | 'other';
export type HrAttendanceStatus = 'present' | 'late' | 'absent' | 'excused' | 'remote' | 'half_day';
export type HrLeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type HrDeclarationCategory = 'travel' | 'meals' | 'accommodation' | 'equipment' | 'training' | 'other';
export type HrDeclarationStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
export type HrCoachingCategory = 'performance' | 'quality' | 'behavior' | 'attendance' | 'development' | 'recognition';
export type HrCoachingStatus = 'open' | 'acknowledged' | 'closed';
export type HrVisibility = 'internal' | 'employee' | 'client';
export type HrEvaluationStatus = 'draft' | 'submitted' | 'acknowledged';
export type HrKpiUnit = 'number' | 'percent' | 'seconds' | 'minutes' | 'currency';
export type HrKpiDirection = 'higher_better' | 'lower_better';
export type HrMilestoneType = 'goal' | 'milestone' | 'certification';
export type HrMilestoneStatus = 'planned' | 'in_progress' | 'achieved' | 'missed';

export interface HrClientRef {
  companyId: string;
  companyName: string | null;
  isPrimary: boolean;
}

export interface HrEmployee {
  id: string;
  employeeNumber: string | null;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  displayName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  pronouns: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  managerId: string | null;
  userId: string | null;
  employmentType: HrEmploymentType;
  status: HrEmployeeStatus;
  startDate: string | null;
  endDate: string | null;
  probationEndDate: string | null;
  location: string | null;
  timezone: string | null;
  weeklyHours: number | null;
  customFields: Record<string, unknown> | null;
  hasSensitive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrEmployeeListItem extends HrEmployee {
  departmentName: string | null;
  managerName: string | null;
  clients: HrClientRef[];
}

export interface HrEmployeeDetail extends HrEmployeeListItem {
  directReports: Array<{
    id: string;
    displayName: string;
    jobTitle: string | null;
    avatarUrl: string | null;
    status: HrEmployeeStatus;
  }>;
}

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

export interface HrOrgChartNode {
  id: string;
  displayName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  managerId: string | null;
  departmentId: string | null;
  status: HrEmployeeStatus;
}

export interface HrDepartment {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  headEmployeeId: string | null;
  color: string | null;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HrAssignment {
  id: string;
  employeeId: string;
  companyId: string;
  companyName: string | null;
  employeeName: string;
  employeeJobTitle: string | null;
  employeeAvatarUrl: string | null;
  employeeStatus: HrEmployeeStatus;
  role: string | null;
  allocationPercent: number;
  isPrimary: boolean;
  startDate: string;
  endDate: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrClientAccount {
  companyId: string;
  companyName: string | null;
  activeCount: number;
  totalCount: number;
  fte: number;
}

export interface HrChecklistTemplateItem {
  id: string;
  title: string;
  description?: string | null;
  assigneeRole: HrAssigneeRole;
  dueOffsetDays: number;
  visibleToEmployee: boolean;
}

export interface HrChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  kind: 'onboarding' | 'offboarding';
  departmentId: string | null;
  items: HrChecklistTemplateItem[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrChecklistTask {
  id: string;
  checklistId: string;
  employeeId: string;
  title: string;
  description: string | null;
  assigneeRole: HrAssigneeRole;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  visibleToEmployee: boolean;
  sortOrder: number;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
}

export interface HrChecklist {
  id: string;
  employeeId: string;
  employeeName: string;
  templateId: string | null;
  kind: 'onboarding' | 'offboarding';
  name: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  startedAt: string;
  completedAt: string | null;
  tasks: HrChecklistTask[];
  progress: { done: number; total: number };
}

export interface HrChecklistOutcome {
  checklistCompleted: boolean;
  kind: string;
  employeeId: string;
  employeeStatus: string | null;
}

export interface HrShift {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string | null;
  companyName: string | null;
  startsAt: string;
  endsAt: string;
  /** What the employee is scheduled to do, e.g. "Cashier". */
  workType: string | null;
  /** Unpaid break inside the shift; both set or both null. */
  breakStartsAt: string | null;
  breakEndsAt: string | null;
  notes: string | null;
}

export interface HrAttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string | null;
  companyName: string | null;
  shiftId: string | null;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number;
  workedMinutes: number | null;
  lateMinutes: number;
  status: HrAttendanceStatus;
  source: 'portal' | 'manual' | 'import' | 'api';
  notes: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface HrAttendanceSummary {
  records: number;
  workedMinutes: number;
  lateMinutes: number;
  byStatus: Record<string, number>;
  attendanceRate: number | null;
}

export interface HrImportResult {
  created: number;
  updated: number;
  errors: Array<{ row: number; reason: string }>;
}

export interface HrLeaveType {
  id: string;
  name: string;
  color: string | null;
  isPaid: boolean;
  requiresApproval: boolean;
  defaultAllowanceDays: number | null;
  isActive: boolean;
}

export interface HrLeaveBalance {
  leaveTypeId: string;
  name: string;
  color: string | null;
  isPaid: boolean;
  allowance: number | null;
  used: number;
  pending: number;
  remaining: number | null;
}

export interface HrLeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  leaveTypeColor: string | null;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: HrLeaveStatus;
  requestedBy: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

/** An expense declaration. The receipt itself is fetched with `declarationReceipt`. */
export interface HrDeclaration {
  id: string;
  employeeId: string;
  expenseDate: string;
  category: HrDeclarationCategory;
  description: string;
  /** Major units, two decimals. */
  amount: number;
  currency: string;
  status: HrDeclarationStatus;
  hasReceipt: boolean;
  receiptFileName: string | null;
  receiptContentType: string | null;
  receiptSize: number | null;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  paidBy: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrDeclarationListItem extends HrDeclaration {
  employeeName: string;
  reviewedByName: string | null;
}

export interface HrCoachingActionItem {
  id: string;
  text: string;
  done: boolean;
}

export interface HrCoachingLog {
  id: string;
  employeeId: string;
  employeeName?: string;
  companyId: string | null;
  companyName?: string | null;
  coachUserId: string | null;
  coachName: string | null;
  sessionDate: string;
  category: HrCoachingCategory;
  topic: string;
  notes: string | null;
  actionItems: HrCoachingActionItem[];
  followUpDate: string | null;
  status: HrCoachingStatus;
  visibility: HrVisibility;
  acknowledgedAt: string | null;
  employeeComment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrEvaluationCriterion {
  id: string;
  label: string;
  description?: string | null;
  weight: number;
  maxScore: number;
}

export interface HrEvaluationScore {
  criterionId: string;
  score: number;
  comment?: string | null;
}

export interface HrEvaluationForm {
  id: string;
  name: string;
  description: string | null;
  criteria: HrEvaluationCriterion[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrEvaluation {
  id: string;
  employeeId: string;
  employeeName?: string;
  formId: string;
  formName?: string | null;
  companyId: string | null;
  companyName?: string | null;
  evaluatorUserId: string | null;
  evaluatorName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  criteria: HrEvaluationCriterion[];
  scores: HrEvaluationScore[];
  overallScore: number | null;
  summary: string | null;
  status: HrEvaluationStatus;
  sharedWithClient: boolean;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  employeeComment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrKpiDefinition {
  id: string;
  name: string;
  description: string | null;
  unit: HrKpiUnit;
  direction: HrKpiDirection;
  target: number | null;
  companyId: string | null;
  companyName: string | null;
  isActive: boolean;
}

export interface HrKpiValue {
  id: string;
  kpiId: string;
  kpiName: string;
  unit: HrKpiUnit;
  direction: HrKpiDirection;
  target: number | null;
  employeeId: string;
  employeeName: string;
  companyId: string | null;
  periodStart: string;
  periodEnd: string;
  value: number;
  onTarget: boolean | null;
  source: string;
  sharedWithClient: boolean;
}

export interface HrMilestone {
  id: string;
  employeeId: string;
  employeeName?: string;
  companyId: string | null;
  companyName?: string | null;
  title: string;
  description: string | null;
  type: HrMilestoneType;
  status: HrMilestoneStatus;
  dueDate: string | null;
  achievedAt: string | null;
  sharedWithClient: boolean;
  createdAt: string;
}

export interface HrPortalSettings {
  id: string;
  isEnabled: boolean;
  employeePortalEnabled: boolean;
  clientPortalEnabled: boolean;
  displayName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  welcomeMessage: string | null;
  supportEmail: string | null;
  hideWeldsuiteBranding: boolean;
  customDomain: string | null;
  clientCanSeeIndividualScores: boolean;
  employeeSelfClockIn: boolean;
  employeeLeaveRequests: boolean;
  employeeDeclarations: boolean;
  updatedAt: string;
}

export interface HrPortalAccess {
  id: string;
  kind: 'employee' | 'client';
  employeeId: string | null;
  personId: string | null;
  companyId: string | null;
  companyName: string | null;
  email: string;
  displayName: string | null;
  status: 'invited' | 'active' | 'revoked';
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface HrClientKpi {
  kpiId: string;
  name: string;
  unit: HrKpiUnit;
  direction: HrKpiDirection;
  target: number | null;
  latest: { periodStart: string; periodEnd: string; average: number; count: number } | null;
  onTarget: boolean | null;
  trend: Array<{ periodStart: string; periodEnd: string; average: number; count: number }>;
  byEmployee: Array<{ employeeId: string; employeeName: string; value: number }>;
}

/** Exactly what a client sees in the workforce portal. */
export interface HrClientView {
  companyId: string;
  generatedAt: string;
  individualScores: boolean;
  team: Array<{
    employeeId: string;
    displayName: string;
    jobTitle: string | null;
    avatarUrl: string | null;
    pronouns: string | null;
    status: HrEmployeeStatus;
    role: string | null;
    allocationPercent: number;
    assignedSince: string;
    averageScore: number | null;
  }>;
  summary: {
    headcount: number;
    fte: number;
    averageEvaluationScore: number | null;
    evaluationsCount: number;
    attendanceRate30d: number | null;
    milestonesAchieved: number;
    milestonesOpen: number;
  };
  kpis: HrClientKpi[];
  evaluations: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    formName: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    overallScore: number | null;
    summary: string | null;
    submittedAt: string | null;
  }>;
  milestones: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    title: string;
    description: string | null;
    type: HrMilestoneType;
    status: HrMilestoneStatus;
    dueDate: string | null;
    achievedAt: string | null;
  }>;
  coaching: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    sessionDate: string;
    category: HrCoachingCategory;
    topic: string;
    status: HrCoachingStatus;
  }>;
}

export interface HrClientDetail {
  company: { id: string; name: string };
  assignments: HrAssignment[];
  portalAccess: HrPortalAccess[];
  clientView: HrClientView;
}

export interface HrDashboard {
  headcount: { total: number; byStatus: Record<string, number> };
  today: {
    date: string;
    clockedIn: number;
    byStatus: Record<string, number>;
    onLeave: Array<{ employeeId: string; employeeName: string; leaveTypeName: string | null; endDate: string }>;
  };
  lifecycle: {
    openTasks: number;
    overdueTasks: number;
    upcomingStarts: Array<{ id: string; displayName: string; jobTitle: string | null; startDate: string | null; status: HrEmployeeStatus }>;
  };
  pendingLeaveRequests: number;
  coachingFollowUpsDue: number;
  evaluations: {
    averageScore90d: number | null;
    recent: Array<{ id: string; employeeId: string; employeeName: string; overallScore: number | null; status: HrEvaluationStatus; submittedAt: string | null }>;
  };
  clients: HrClientAccount[];
}

/** A workspace member who can be made an employee (see `listAvailableMembers`). */
export interface HrAvailableMember {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  title: string | null;
  phone: string | null;
  memberType: 'INTERNAL' | 'EMPLOYEE';
}

// ---------------------------------------------------------------------------
// My HR — the signed-in member's own employee record (`/weldhr/me/*`).
// Same shapes the workforce portal serves; see services/weldhr/portal-self-service.
// ---------------------------------------------------------------------------

export interface HrSelfProfile {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  employeeNumber: string | null;
  status: HrEmployeeStatus;
  employmentType: HrEmploymentType;
  startDate: string | null;
  location: string | null;
  departmentName: string | null;
  manager: { displayName: string; email: string | null } | null;
  clients: HrClientRef[];
}

export interface HrSelfFeatures {
  /** Clock in/out from My HR (WeldHR settings → portal → self clock-in). */
  selfClockIn: boolean;
  /** Request leave from My HR (WeldHR settings → portal → leave requests). */
  leaveRequests: boolean;
  /** Submit expense declarations from My HR (WeldHR settings → portal → declarations). */
  declarations: boolean;
}

export interface HrSelf {
  /** Null when the member is not linked to an employee record (or it was terminated). */
  employee: HrSelfProfile | null;
  features: HrSelfFeatures;
}

export interface HrSelfOverview {
  profile: HrSelfProfile;
  clock: { clockedIn: boolean; since: string | null };
  upcomingShifts: Array<{ id: string; startsAt: string; endsAt: string; companyName: string | null }>;
  leaveBalances: HrLeaveBalance[];
  openTasks: number;
  toAcknowledge: { coaching: number; evaluations: number };
  latestEvaluation: { id: string; overallScore: number | null; formName: string | null; submittedAt: string | null } | null;
  milestones: { achieved: number; open: number };
}

export interface HrSelfAttendance {
  records: Array<{
    id: string;
    date: string;
    clockIn: string | null;
    clockOut: string | null;
    breakMinutes: number | null;
    workedMinutes: number | null;
    lateMinutes: number | null;
    status: HrAttendanceStatus;
    source: string;
    approved: boolean;
    companyName: string | null;
  }>;
  shifts: Array<{ id: string; startsAt: string; endsAt: string; companyName: string | null; notes: string | null }>;
}

export interface HrSelfClockResult {
  id: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: HrAttendanceStatus;
  workedMinutes: number | null;
  lateMinutes: number | null;
}

export interface HrSelfLeaveRequest {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  leaveTypeColor: string | null;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: HrLeaveStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
}

export interface HrSelfLeave {
  types: Array<{ id: string; name: string; color: string | null; requiresApproval: boolean }>;
  balances: HrLeaveBalance[];
  requests: HrSelfLeaveRequest[];
}

export interface HrSelfDeclaration {
  id: string;
  expenseDate: string;
  category: HrDeclarationCategory;
  description: string;
  amount: number;
  currency: string;
  status: HrDeclarationStatus;
  hasReceipt: boolean;
  receiptFileName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface HrSelfDeclarations {
  declarations: HrSelfDeclaration[];
  /** Money still outstanding, per currency: awaiting a decision, and approved but not yet paid. */
  open: Array<{ currency: string; pending: number; approved: number }>;
}

export interface HrSelfTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  assigneeRole: HrAssigneeRole;
  completedAt: string | null;
  /** Only tasks assigned to the employee role, on a checklist still in progress. */
  canComplete: boolean;
  checklistName: string;
  checklistKind: 'onboarding' | 'offboarding';
}

export interface HrSelfCoachingLog {
  id: string;
  sessionDate: string;
  category: HrCoachingCategory;
  topic: string;
  notes: string | null;
  actionItems: HrCoachingActionItem[];
  followUpDate: string | null;
  status: HrCoachingStatus;
  coachName: string | null;
  acknowledgedAt: string | null;
  employeeComment: string | null;
}

export interface HrSelfEvaluation {
  id: string;
  formName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  criteria: HrEvaluationCriterion[];
  scores: HrEvaluationScore[];
  overallScore: number | null;
  summary: string | null;
  status: HrEvaluationStatus;
  evaluatorName: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  employeeComment: string | null;
}

export interface HrSelfPerformance {
  kpis: Array<{
    id: string;
    kpiId: string;
    kpiName: string;
    unit: HrKpiUnit;
    direction: HrKpiDirection;
    target: number | null;
    value: number;
    onTarget: boolean | null;
    periodStart: string;
    periodEnd: string;
  }>;
  milestones: Array<{
    id: string;
    title: string;
    description: string | null;
    type: HrMilestoneType;
    status: HrMilestoneStatus;
    dueDate: string | null;
    achievedAt: string | null;
    companyName: string | null;
  }>;
}

export interface HrSelfAcknowledgeResult {
  id: string;
  acknowledgedAt: string | null;
  status: string;
}

export interface HrEmployeeListParams {
  search?: string;
  status?: string;
  departmentId?: string;
  managerId?: string;
  companyId?: string;
  limit?: number;
  cursor?: string;
}

export interface HrAttendanceListParams {
  employeeId?: string;
  companyId?: string;
  from?: string;
  to?: string;
  status?: string;
  unapproved?: boolean;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const base = '/weldhr';

function qs(params: object): string {
  return buildQueryString(params as Record<string, unknown>);
}

function receiptForm(file: File): FormData {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export function createWeldHrApi(api: ClientApi) {
  return {
    dashboard(): Promise<DataResponse<HrDashboard>> {
      return api.get(`${base}/dashboard`);
    },

    // Employees --------------------------------------------------------------
    listEmployees(params: HrEmployeeListParams = {}): Promise<ListResponse<HrEmployeeListItem>> {
      return api.get(`${base}/employees${qs(params)}`);
    },
    getEmployee(id: string): Promise<DataResponse<HrEmployeeDetail>> {
      return api.get(`${base}/employees/${id}`);
    },
    createEmployee(body: CreateHrEmployeeInput): Promise<DataResponse<HrEmployee>> {
      return api.post(`${base}/employees`, body);
    },
    createEmployeeFromMember(body: CreateHrEmployeeFromMemberInput): Promise<DataResponse<HrEmployee>> {
      return api.post(`${base}/employees/from-member`, body);
    },
    /** Active INTERNAL / EMPLOYEE members not yet linked to an employee. */
    listAvailableMembers(params: { search?: string; limit?: number } = {}): Promise<DataResponse<HrAvailableMember[]>> {
      return api.get(`${base}/employees/available-members${qs(params)}`);
    },
    updateEmployee(id: string, body: UpdateHrEmployeeInput): Promise<DataResponse<HrEmployee>> {
      return api.patch(`${base}/employees/${id}`, body);
    },
    deleteEmployee(id: string): Promise<void> {
      return api.delete(`${base}/employees/${id}`);
    },
    /** Requires `employees:sensitive`. Audited. */
    getSensitive(id: string): Promise<DataResponse<HrEmployeeSensitive>> {
      return api.get(`${base}/employees/${id}/sensitive`);
    },
    updateSensitive(id: string, body: HrEmployeeSensitiveInput): Promise<DataResponse<HrEmployeeSensitive>> {
      return api.put(`${base}/employees/${id}/sensitive`, body);
    },
    orgChart(): Promise<DataResponse<HrOrgChartNode[]>> {
      return api.get(`${base}/org-chart`);
    },

    // Departments ------------------------------------------------------------
    listDepartments(): Promise<DataResponse<HrDepartment[]>> {
      return api.get(`${base}/departments`);
    },
    createDepartment(body: CreateHrDepartmentInput): Promise<DataResponse<HrDepartment>> {
      return api.post(`${base}/departments`, body);
    },
    updateDepartment(id: string, body: Partial<CreateHrDepartmentInput>): Promise<DataResponse<HrDepartment>> {
      return api.patch(`${base}/departments/${id}`, body);
    },
    deleteDepartment(id: string): Promise<void> {
      return api.delete(`${base}/departments/${id}`);
    },

    // Assignments & clients --------------------------------------------------
    listAssignments(params: { employeeId?: string; companyId?: string; active?: boolean } = {}): Promise<DataResponse<HrAssignment[]>> {
      return api.get(`${base}/assignments${qs(params)}`);
    },
    createAssignment(body: CreateHrAssignmentInput): Promise<DataResponse<HrAssignment>> {
      return api.post(`${base}/assignments`, body);
    },
    updateAssignment(id: string, body: UpdateHrAssignmentInput): Promise<DataResponse<HrAssignment>> {
      return api.patch(`${base}/assignments/${id}`, body);
    },
    deleteAssignment(id: string): Promise<void> {
      return api.delete(`${base}/assignments/${id}`);
    },
    listClients(): Promise<DataResponse<HrClientAccount[]>> {
      return api.get(`${base}/clients`);
    },
    getClient(companyId: string): Promise<DataResponse<HrClientDetail>> {
      return api.get(`${base}/clients/${companyId}`);
    },

    // Lifecycle --------------------------------------------------------------
    listChecklistTemplates(kind?: 'onboarding' | 'offboarding'): Promise<DataResponse<HrChecklistTemplate[]>> {
      return api.get(`${base}/checklist-templates${qs({ kind })}`);
    },
    createChecklistTemplate(body: CreateHrChecklistTemplateInput): Promise<DataResponse<HrChecklistTemplate>> {
      return api.post(`${base}/checklist-templates`, body);
    },
    updateChecklistTemplate(id: string, body: Partial<CreateHrChecklistTemplateInput>): Promise<DataResponse<HrChecklistTemplate>> {
      return api.patch(`${base}/checklist-templates/${id}`, body);
    },
    deleteChecklistTemplate(id: string): Promise<void> {
      return api.delete(`${base}/checklist-templates/${id}`);
    },
    listChecklists(params: { employeeId?: string; status?: string; kind?: string } = {}): Promise<DataResponse<HrChecklist[]>> {
      return api.get(`${base}/checklists${qs(params)}`);
    },
    startChecklist(body: { employeeId: string; templateId: string; anchorDate?: string }): Promise<DataResponse<HrChecklist>> {
      return api.post(`${base}/checklists`, body);
    },
    cancelChecklist(id: string): Promise<DataResponse<HrChecklist>> {
      return api.post(`${base}/checklists/${id}/cancel`, {});
    },
    deleteChecklist(id: string): Promise<void> {
      return api.delete(`${base}/checklists/${id}`);
    },
    addChecklistTask(checklistId: string, body: CreateHrChecklistTaskInput): Promise<DataResponse<HrChecklistTask>> {
      return api.post(`${base}/checklists/${checklistId}/tasks`, body);
    },
    updateChecklistTask(
      taskId: string,
      body: UpdateHrChecklistTaskInput,
    ): Promise<DataResponse<{ task: HrChecklistTask; outcome: HrChecklistOutcome }>> {
      return api.patch(`${base}/checklists/tasks/${taskId}`, body);
    },
    deleteChecklistTask(taskId: string): Promise<void> {
      return api.delete(`${base}/checklists/tasks/${taskId}`);
    },

    // Shifts & attendance ----------------------------------------------------
    listShifts(params: { from?: string; to?: string; employeeId?: string; companyId?: string } = {}): Promise<DataResponse<HrShift[]>> {
      return api.get(`${base}/shifts${qs(params)}`);
    },
    createShift(body: CreateHrShiftInput): Promise<DataResponse<HrShift>> {
      return api.post(`${base}/shifts`, body);
    },
    updateShift(id: string, body: Partial<Omit<CreateHrShiftInput, 'employeeId'>>): Promise<DataResponse<HrShift>> {
      return api.patch(`${base}/shifts/${id}`, body);
    },
    deleteShift(id: string): Promise<void> {
      return api.delete(`${base}/shifts/${id}`);
    },
    listAttendance(params: HrAttendanceListParams = {}): Promise<ListResponse<HrAttendanceRecord>> {
      return api.get(`${base}/attendance${qs(params)}`);
    },
    attendanceSummary(params: { from?: string; to?: string; employeeId?: string; companyId?: string } = {}): Promise<DataResponse<HrAttendanceSummary>> {
      return api.get(`${base}/attendance/summary${qs(params)}`);
    },
    createAttendance(body: CreateHrAttendanceInput): Promise<DataResponse<HrAttendanceRecord>> {
      return api.post(`${base}/attendance`, body);
    },
    updateAttendance(id: string, body: UpdateHrAttendanceInput): Promise<DataResponse<HrAttendanceRecord>> {
      return api.patch(`${base}/attendance/${id}`, body);
    },
    deleteAttendance(id: string): Promise<void> {
      return api.delete(`${base}/attendance/${id}`);
    },
    approveAttendance(ids: string[]): Promise<DataResponse<{ approved: number }>> {
      return api.post(`${base}/attendance/approve`, { ids });
    },
    importAttendance(body: ImportHrAttendanceInput): Promise<DataResponse<HrImportResult>> {
      return api.post(`${base}/attendance/import`, body);
    },

    // Leave ------------------------------------------------------------------
    listLeaveTypes(includeInactive = false): Promise<DataResponse<HrLeaveType[]>> {
      return api.get(`${base}/leave-types${qs({ includeInactive: includeInactive || undefined })}`);
    },
    createLeaveType(body: CreateHrLeaveTypeInput): Promise<DataResponse<HrLeaveType>> {
      return api.post(`${base}/leave-types`, body);
    },
    updateLeaveType(id: string, body: Partial<CreateHrLeaveTypeInput>): Promise<DataResponse<HrLeaveType>> {
      return api.patch(`${base}/leave-types/${id}`, body);
    },
    deleteLeaveType(id: string): Promise<DataResponse<{ archived: boolean }>> {
      return api.delete(`${base}/leave-types/${id}`);
    },
    leaveBalances(employeeId: string, year?: number): Promise<DataResponse<HrLeaveBalance[]>> {
      return api.get(`${base}/leave-allowances/balances/${employeeId}${qs({ year })}`);
    },
    setLeaveAllowance(body: { employeeId: string; leaveTypeId: string; year: number; days: number }): Promise<DataResponse<unknown>> {
      return api.put(`${base}/leave-allowances`, body);
    },
    listLeaveRequests(params: { employeeId?: string; status?: string; from?: string; to?: string } = {}): Promise<DataResponse<HrLeaveRequest[]>> {
      return api.get(`${base}/leave-requests${qs(params)}`);
    },
    createLeaveRequest(body: CreateHrLeaveRequestInput): Promise<DataResponse<HrLeaveRequest>> {
      return api.post(`${base}/leave-requests`, body);
    },
    reviewLeaveRequest(id: string, body: ReviewHrLeaveRequestInput): Promise<DataResponse<HrLeaveRequest>> {
      return api.post(`${base}/leave-requests/${id}/review`, body);
    },
    cancelLeaveRequest(id: string): Promise<DataResponse<HrLeaveRequest>> {
      return api.post(`${base}/leave-requests/${id}/cancel`, {});
    },
    deleteLeaveRequest(id: string): Promise<void> {
      return api.delete(`${base}/leave-requests/${id}`);
    },

    // Declarations -----------------------------------------------------------
    listDeclarations(params: { employeeId?: string; status?: string; category?: string; from?: string; to?: string } = {}): Promise<DataResponse<HrDeclarationListItem[]>> {
      return api.get(`${base}/declarations${qs(params)}`);
    },
    createDeclaration(body: CreateHrDeclarationInput): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/declarations`, body);
    },
    updateDeclaration(id: string, body: UpdateHrDeclarationInput): Promise<DataResponse<HrDeclaration>> {
      return api.patch(`${base}/declarations/${id}`, body);
    },
    reviewDeclaration(id: string, body: ReviewHrDeclarationInput): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/declarations/${id}/review`, body);
    },
    markDeclarationPaid(id: string): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/declarations/${id}/pay`, {});
    },
    cancelDeclaration(id: string): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/declarations/${id}/cancel`, {});
    },
    deleteDeclaration(id: string): Promise<void> {
      return api.delete(`${base}/declarations/${id}`);
    },
    uploadDeclarationReceipt(id: string, file: File): Promise<DataResponse<HrDeclaration>> {
      return api.postForm(`${base}/declarations/${id}/receipt`, receiptForm(file));
    },
    /** The receipt file itself; the caller reads it as a blob. */
    declarationReceipt(id: string): Promise<Response> {
      return api.getRaw(`${base}/declarations/${id}/receipt`);
    },

    // Coaching ---------------------------------------------------------------
    listCoaching(params: { employeeId?: string; companyId?: string; status?: string; category?: string; from?: string; to?: string; followUpDue?: boolean } = {}): Promise<DataResponse<HrCoachingLog[]>> {
      return api.get(`${base}/coaching${qs(params)}`);
    },
    createCoaching(body: CreateHrCoachingLogInput): Promise<DataResponse<HrCoachingLog>> {
      return api.post(`${base}/coaching`, body);
    },
    updateCoaching(id: string, body: UpdateHrCoachingLogInput): Promise<DataResponse<HrCoachingLog>> {
      return api.patch(`${base}/coaching/${id}`, body);
    },
    deleteCoaching(id: string): Promise<void> {
      return api.delete(`${base}/coaching/${id}`);
    },

    // Evaluations ------------------------------------------------------------
    listEvaluationForms(activeOnly = false): Promise<DataResponse<HrEvaluationForm[]>> {
      return api.get(`${base}/evaluation-forms${qs({ activeOnly: activeOnly || undefined })}`);
    },
    createEvaluationForm(body: CreateHrEvaluationFormInput): Promise<DataResponse<HrEvaluationForm>> {
      return api.post(`${base}/evaluation-forms`, body);
    },
    updateEvaluationForm(id: string, body: Partial<CreateHrEvaluationFormInput>): Promise<DataResponse<HrEvaluationForm>> {
      return api.patch(`${base}/evaluation-forms/${id}`, body);
    },
    deleteEvaluationForm(id: string): Promise<void> {
      return api.delete(`${base}/evaluation-forms/${id}`);
    },
    listEvaluations(params: { employeeId?: string; companyId?: string; status?: string; formId?: string; from?: string; to?: string } = {}): Promise<DataResponse<HrEvaluation[]>> {
      return api.get(`${base}/evaluations${qs(params)}`);
    },
    getEvaluation(id: string): Promise<DataResponse<HrEvaluation>> {
      return api.get(`${base}/evaluations/${id}`);
    },
    createEvaluation(body: CreateHrEvaluationInput): Promise<DataResponse<HrEvaluation>> {
      return api.post(`${base}/evaluations`, body);
    },
    updateEvaluation(id: string, body: UpdateHrEvaluationInput): Promise<DataResponse<HrEvaluation>> {
      return api.patch(`${base}/evaluations/${id}`, body);
    },
    deleteEvaluation(id: string): Promise<void> {
      return api.delete(`${base}/evaluations/${id}`);
    },

    // KPIs -------------------------------------------------------------------
    listKpis(params: { companyId?: string; includeInactive?: boolean } = {}): Promise<DataResponse<HrKpiDefinition[]>> {
      return api.get(`${base}/kpis${qs(params)}`);
    },
    createKpi(body: CreateHrKpiDefinitionInput): Promise<DataResponse<HrKpiDefinition>> {
      return api.post(`${base}/kpis`, body);
    },
    updateKpi(id: string, body: Partial<CreateHrKpiDefinitionInput>): Promise<DataResponse<HrKpiDefinition>> {
      return api.patch(`${base}/kpis/${id}`, body);
    },
    deleteKpi(id: string): Promise<DataResponse<{ archived: boolean }>> {
      return api.delete(`${base}/kpis/${id}`);
    },
    listKpiValues(params: { employeeId?: string; kpiId?: string; companyId?: string; from?: string; to?: string } = {}): Promise<DataResponse<HrKpiValue[]>> {
      return api.get(`${base}/kpi-values${qs(params)}`);
    },
    createKpiValue(body: CreateHrKpiValueInput): Promise<DataResponse<HrKpiValue>> {
      return api.post(`${base}/kpi-values`, body);
    },
    updateKpiValue(id: string, body: Partial<Omit<CreateHrKpiValueInput, 'kpiId' | 'employeeId'>>): Promise<DataResponse<HrKpiValue>> {
      return api.patch(`${base}/kpi-values/${id}`, body);
    },
    deleteKpiValue(id: string): Promise<void> {
      return api.delete(`${base}/kpi-values/${id}`);
    },
    importKpiValues(body: ImportHrKpiValuesInput): Promise<DataResponse<HrImportResult>> {
      return api.post(`${base}/kpi-values/import`, body);
    },

    // Milestones -------------------------------------------------------------
    listMilestones(params: { employeeId?: string; companyId?: string; status?: string } = {}): Promise<DataResponse<HrMilestone[]>> {
      return api.get(`${base}/milestones${qs(params)}`);
    },
    createMilestone(body: CreateHrMilestoneInput): Promise<DataResponse<HrMilestone>> {
      return api.post(`${base}/milestones`, body);
    },
    updateMilestone(id: string, body: UpdateHrMilestoneInput): Promise<DataResponse<HrMilestone>> {
      return api.patch(`${base}/milestones/${id}`, body);
    },
    deleteMilestone(id: string): Promise<void> {
      return api.delete(`${base}/milestones/${id}`);
    },

    // Portal -----------------------------------------------------------------
    getPortalSettings(): Promise<DataResponse<HrPortalSettings>> {
      return api.get(`${base}/portal/settings`);
    },
    updatePortalSettings(body: UpdateHrPortalSettingsInput): Promise<DataResponse<HrPortalSettings>> {
      return api.put(`${base}/portal/settings`, body);
    },
    listPortalAccess(params: { kind?: 'employee' | 'client'; companyId?: string; employeeId?: string } = {}): Promise<DataResponse<HrPortalAccess[]>> {
      return api.get(`${base}/portal/access${qs(params)}`);
    },
    invitePortalAccess(body: InviteHrPortalAccessInput): Promise<DataResponse<HrPortalAccess & { emailed: boolean }>> {
      return api.post(`${base}/portal/access`, body);
    },
    revokePortalAccess(id: string): Promise<DataResponse<HrPortalAccess>> {
      return api.post(`${base}/portal/access/${id}/revoke`, {});
    },
    restorePortalAccess(id: string): Promise<DataResponse<HrPortalAccess>> {
      return api.post(`${base}/portal/access/${id}/restore`, {});
    },
    deletePortalAccess(id: string): Promise<void> {
      return api.delete(`${base}/portal/access/${id}`);
    },

    // My HR (the caller's own employee record) -------------------------------
    me(): Promise<DataResponse<HrSelf>> {
      return api.get(`${base}/me`);
    },
    meOverview(): Promise<DataResponse<HrSelfOverview>> {
      return api.get(`${base}/me/overview`);
    },
    meAttendance(params: { from?: string; to?: string } = {}): Promise<DataResponse<HrSelfAttendance>> {
      return api.get(`${base}/me/attendance${qs(params)}`);
    },
    meClock(body: HrSelfServiceClockInput): Promise<DataResponse<HrSelfClockResult>> {
      return api.post(`${base}/me/clock`, body);
    },
    meLeave(): Promise<DataResponse<HrSelfLeave>> {
      return api.get(`${base}/me/leave`);
    },
    meRequestLeave(body: HrSelfServiceLeaveRequestInput): Promise<DataResponse<HrLeaveRequest>> {
      return api.post(`${base}/me/leave`, body);
    },
    meCancelLeave(id: string): Promise<DataResponse<HrLeaveRequest>> {
      return api.post(`${base}/me/leave/${id}/cancel`, {});
    },
    meDeclarations(): Promise<DataResponse<HrSelfDeclarations>> {
      return api.get(`${base}/me/declarations`);
    },
    meCreateDeclaration(body: HrSelfServiceDeclarationInput): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/me/declarations`, body);
    },
    meCancelDeclaration(id: string): Promise<DataResponse<HrDeclaration>> {
      return api.post(`${base}/me/declarations/${id}/cancel`, {});
    },
    meUploadDeclarationReceipt(id: string, file: File): Promise<DataResponse<HrDeclaration>> {
      return api.postForm(`${base}/me/declarations/${id}/receipt`, receiptForm(file));
    },
    meDeclarationReceipt(id: string): Promise<Response> {
      return api.getRaw(`${base}/me/declarations/${id}/receipt`);
    },
    meTasks(): Promise<DataResponse<HrSelfTask[]>> {
      return api.get(`${base}/me/tasks`);
    },
    meCompleteTask(id: string, done = true): Promise<DataResponse<{ ok: true; checklistCompleted: boolean }>> {
      return api.post(`${base}/me/tasks/${id}/complete${done ? '' : '?undo=true'}`, {});
    },
    meCoaching(): Promise<DataResponse<HrSelfCoachingLog[]>> {
      return api.get(`${base}/me/coaching`);
    },
    meAcknowledgeCoaching(id: string, body: HrSelfServiceAcknowledgeInput = {}): Promise<DataResponse<HrSelfAcknowledgeResult>> {
      return api.post(`${base}/me/coaching/${id}/acknowledge`, body);
    },
    meEvaluations(): Promise<DataResponse<HrSelfEvaluation[]>> {
      return api.get(`${base}/me/evaluations`);
    },
    meAcknowledgeEvaluation(id: string, body: HrSelfServiceAcknowledgeInput = {}): Promise<DataResponse<HrSelfAcknowledgeResult>> {
      return api.post(`${base}/me/evaluations/${id}/acknowledge`, body);
    },
    mePerformance(): Promise<DataResponse<HrSelfPerformance>> {
      return api.get(`${base}/me/performance`);
    },
  };
}

export type WeldHrApi = ReturnType<typeof createWeldHrApi>;
