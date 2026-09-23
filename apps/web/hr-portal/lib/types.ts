/**
 * Response shapes served by `/public/hr-portal/*` (see
 * `apps/workers/app-api/src/routes/public-hr-portal/index.ts` and the
 * services it calls under `apps/workers/app-api/src/services/weldhr/`).
 * Kept as plain local types so the portal carries no dependency on the
 * platform's API client. `HrClientView` mirrors the type of the same name in
 * `packages/clients/app-api-client/src/domains/weldhr.ts`; change both together.
 */

export type PortalAccessKind = 'employee' | 'client';

export interface PortalFeatures {
  selfClockIn: boolean;
  leaveRequests: boolean;
  individualScores: boolean;
}

export interface PortalConfig {
  displayName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  welcomeMessage: string | null;
  supportEmail: string | null;
  hideWeldsuiteBranding: boolean;
  employeePortalEnabled: boolean;
  clientPortalEnabled: boolean;
  features: PortalFeatures;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthRequestResult {
  ok: true;
}

export interface PortalSession {
  token: string;
  kind: PortalAccessKind;
  expiresIn: number;
}

export interface PortalPickerOption {
  accessId: string;
  kind: PortalAccessKind;
  companyName: string | null;
  displayName: string | null;
}

export interface AuthVerifyResult {
  session?: PortalSession;
  pickerToken?: string;
  options?: PortalPickerOption[];
}

// ---------------------------------------------------------------------------
// /me
// ---------------------------------------------------------------------------

export interface MeBase {
  kind: PortalAccessKind;
  email: string;
  config: PortalConfig;
  displayName: string;
}

export interface MeEmployee extends MeBase {
  kind: 'employee';
  employee: EmployeeProfile;
}

export interface MeClient extends MeBase {
  kind: 'client';
  company: { id: string; name: string | null };
}

export type Me = MeEmployee | MeClient;

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

export type HrEmployeeStatus = 'onboarding' | 'active' | 'on_leave' | 'offboarding' | 'terminated';

export interface EmployeeProfile {
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
  employmentType: string | null;
  startDate: string | null;
  location: string | null;
  departmentName: string | null;
  manager: { displayName: string; email: string | null } | null;
  clients: Array<{ companyId: string; companyName: string | null; isPrimary: boolean }>;
}

export interface LeaveBalance {
  leaveTypeId: string;
  name: string;
  color: string | null;
  isPaid: boolean;
  allowance: number | null;
  used: number;
  pending: number;
  remaining: number | null;
}

export interface EmployeeOverview {
  profile: EmployeeProfile;
  clock: { clockedIn: boolean; since: string | null };
  upcomingShifts: Array<{ id: string; startsAt: string; endsAt: string; companyName: string | null }>;
  leaveBalances: LeaveBalance[];
  openTasks: number;
  toAcknowledge: { coaching: number; evaluations: number };
  latestEvaluation: { id: string; overallScore: number | null; formName: string | null; submittedAt: string | null } | null;
  milestones: { achieved: number; open: number };
}

export interface AttendanceRecord {
  id: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  status: string;
  source: string;
  approved: boolean;
  companyName: string | null;
}

export interface Shift {
  id: string;
  startsAt: string;
  endsAt: string;
  companyName: string | null;
  notes?: string | null;
}

export interface EmployeeAttendance {
  records: AttendanceRecord[];
  shifts: Shift[];
}

export interface ClockResult {
  id: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  workedMinutes: number | null;
  lateMinutes: number | null;
}

export interface LeaveType {
  id: string;
  name: string;
  color: string | null;
  requiresApproval: boolean;
}

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  leaveTypeColor: string | null;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveRequestStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
}

export interface EmployeeLeave {
  types: LeaveType[];
  balances: LeaveBalance[];
  requests: LeaveRequest[];
}

export interface CoachingActionItem {
  id: string;
  text: string;
  done: boolean;
}

export type CoachingStatus = 'open' | 'acknowledged' | 'closed';

export interface CoachingLog {
  id: string;
  sessionDate: string;
  category: string | null;
  topic: string | null;
  notes: string | null;
  actionItems: CoachingActionItem[];
  followUpDate: string | null;
  status: CoachingStatus;
  coachName: string | null;
  acknowledgedAt: string | null;
  employeeComment: string | null;
}

export interface AcknowledgeResult {
  id: string;
  acknowledgedAt: string | null;
  status: string;
}

export type EvaluationStatus = 'draft' | 'submitted' | 'acknowledged';

/** The form's criteria, snapshotted when the evaluation was created. */
export interface EvaluationCriterion {
  id: string;
  label: string;
  description?: string | null;
  weight: number;
  maxScore: number;
}

export interface EvaluationScore {
  criterionId: string;
  score: number;
  comment?: string | null;
}

export interface Evaluation {
  id: string;
  formName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  criteria: EvaluationCriterion[];
  scores: EvaluationScore[];
  overallScore: number | null;
  summary: string | null;
  status: EvaluationStatus;
  evaluatorName: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  employeeComment: string | null;
}

export interface EmployeeTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  assigneeRole: string;
  completedAt: string | null;
  canComplete: boolean;
  checklistName: string;
  checklistKind: string;
}

export interface CompleteTaskResult {
  ok: true;
  checklistCompleted: boolean;
}

export type HrKpiUnit = 'number' | 'percent' | 'seconds' | 'minutes' | 'currency';
export type HrKpiDirection = 'higher_better' | 'lower_better';

export interface EmployeeKpiValue {
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
}

export type HrMilestoneStatus = 'planned' | 'in_progress' | 'achieved' | 'missed';

export interface EmployeeMilestone {
  id: string;
  title: string;
  description: string | null;
  type: string | null;
  status: HrMilestoneStatus;
  dueDate: string | null;
  achievedAt: string | null;
  companyName?: string | null;
}

export interface EmployeePerformance {
  kpis: EmployeeKpiValue[];
  milestones: EmployeeMilestone[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type HrCoachingCategory = 'performance' | 'quality' | 'behavior' | 'attendance' | 'development' | 'recognition';
export type HrMilestoneType = 'goal' | 'milestone' | 'certification';

/** Exactly what a client sees — built server-side by services/weldhr/client-view.ts. */
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
  kpis: Array<{
    kpiId: string;
    name: string;
    unit: HrKpiUnit;
    direction: HrKpiDirection;
    target: number | null;
    latest: { periodStart: string; periodEnd: string; average: number; count: number } | null;
    onTarget: boolean | null;
    trend: Array<{ periodStart: string; periodEnd: string; average: number; count: number }>;
    byEmployee: Array<{ employeeId: string; employeeName: string; value: number }>;
  }>;
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
    status: CoachingStatus;
  }>;
}

export interface ClientTeamMemberDetail {
  member: HrClientView['team'][number];
  milestones: EmployeeMilestone[];
  evaluations: Array<{
    id: string;
    formName: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    overallScore: number | null;
    summary: string | null;
    submittedAt: string | null;
  }>;
  kpis: Array<{
    id: string;
    kpiName: string;
    unit: HrKpiUnit;
    direction: HrKpiDirection;
    target: number | null;
    value: number;
    onTarget: boolean | null;
    periodStart: string;
    periodEnd: string;
  }>;
}

export type ClientRequestStatus = string;

export interface ClientRequestTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: ClientRequestStatus;
  createdAt: string;
  updatedAt?: string;
}
