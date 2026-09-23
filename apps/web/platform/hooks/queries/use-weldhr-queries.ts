/**
 * WeldHR hooks — employees, lifecycle, time, performance and the workforce
 * portal settings.
 *
 * Every key sits under ['weldhr'] (the realtime sync map invalidates that
 * root on any hr_* event), and mutations invalidate the same root: HR screens
 * cross-reference each other heavily — finishing an offboarding task changes
 * the employee, their assignments and the dashboard — so a narrow invalidation
 * would leave something stale.
 *
 * The sensitive block is deliberately fetched on demand with `staleTime: 0`
 * and `gcTime: 0`: each reveal is audited server-side, and caching it would
 * keep personal data in memory after the user closed the panel.
 */

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  HrAttendanceListParams,
  HrEmployeeListParams,
} from '@weldsuite/app-api-client/domains/weldhr';
import type {
  CreateHrAssignmentInput,
  CreateHrAttendanceInput,
  CreateHrChecklistTaskInput,
  CreateHrChecklistTemplateInput,
  CreateHrCoachingLogInput,
  CreateHrDepartmentInput,
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
  ImportHrAttendanceInput,
  ImportHrKpiValuesInput,
  InviteHrPortalAccessInput,
  ReviewHrLeaveRequestInput,
  UpdateHrAssignmentInput,
  UpdateHrAttendanceInput,
  UpdateHrChecklistTaskInput,
  UpdateHrCoachingLogInput,
  UpdateHrEmployeeInput,
  UpdateHrEvaluationInput,
  UpdateHrMilestoneInput,
  UpdateHrPortalSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldhr';

export const weldhrKeys = {
  all: ['weldhr'] as const,
  dashboard: () => [...weldhrKeys.all, 'dashboard'] as const,
  employees: (params: HrEmployeeListParams) => [...weldhrKeys.all, 'employees', params] as const,
  employee: (id: string) => [...weldhrKeys.all, 'employee', id] as const,
  sensitive: (id: string) => [...weldhrKeys.all, 'sensitive', id] as const,
  orgChart: () => [...weldhrKeys.all, 'org-chart'] as const,
  departments: () => [...weldhrKeys.all, 'departments'] as const,
  assignments: (params: object) => [...weldhrKeys.all, 'assignments', params] as const,
  clients: () => [...weldhrKeys.all, 'clients'] as const,
  client: (companyId: string) => [...weldhrKeys.all, 'client', companyId] as const,
  templates: (kind?: string) => [...weldhrKeys.all, 'templates', kind ?? 'all'] as const,
  checklists: (params: object) => [...weldhrKeys.all, 'checklists', params] as const,
  shifts: (params: object) => [...weldhrKeys.all, 'shifts', params] as const,
  attendance: (params: object) => [...weldhrKeys.all, 'attendance', params] as const,
  attendanceSummary: (params: object) => [...weldhrKeys.all, 'attendance-summary', params] as const,
  leaveTypes: (includeInactive: boolean) => [...weldhrKeys.all, 'leave-types', includeInactive] as const,
  leaveBalances: (employeeId: string, year: number) => [...weldhrKeys.all, 'leave-balances', employeeId, year] as const,
  leaveRequests: (params: object) => [...weldhrKeys.all, 'leave-requests', params] as const,
  coaching: (params: object) => [...weldhrKeys.all, 'coaching', params] as const,
  evaluationForms: () => [...weldhrKeys.all, 'evaluation-forms'] as const,
  evaluations: (params: object) => [...weldhrKeys.all, 'evaluations', params] as const,
  evaluation: (id: string) => [...weldhrKeys.all, 'evaluation', id] as const,
  kpis: (params: object) => [...weldhrKeys.all, 'kpis', params] as const,
  kpiValues: (params: object) => [...weldhrKeys.all, 'kpi-values', params] as const,
  milestones: (params: object) => [...weldhrKeys.all, 'milestones', params] as const,
  portalSettings: () => [...weldhrKeys.all, 'portal-settings'] as const,
  portalAccess: (params: object) => [...weldhrKeys.all, 'portal-access', params] as const,
};

/** Mutation hook that invalidates the whole WeldHR cache on success. */
function useHrMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: weldhrKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function useHrDashboard() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.dashboard(), queryFn: () => weldhr.dashboard(), select: (r) => r.data });
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export function useHrEmployees(params: HrEmployeeListParams = {}, opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.employees(params),
    queryFn: () => weldhr.listEmployees(params),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useHrEmployee(id: string | undefined) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.employee(id ?? ''),
    queryFn: () => weldhr.getEmployee(id as string),
    select: (r) => r.data,
    enabled: Boolean(id),
  });
}

/** Audited read. Only enable while the sensitive panel is open. */
export function useHrEmployeeSensitive(id: string | undefined, enabled: boolean) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.sensitive(id ?? ''),
    queryFn: () => weldhr.getSensitive(id as string),
    select: (r) => r.data,
    enabled: Boolean(id) && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useCreateHrEmployee() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrEmployeeInput) => weldhr.createEmployee(input));
}

export function useUpdateHrEmployee() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrEmployeeInput & { id: string }) => weldhr.updateEmployee(id, input));
}

export function useDeleteHrEmployee() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteEmployee(id));
}

export function useUpdateHrEmployeeSensitive() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: HrEmployeeSensitiveInput & { id: string }) => weldhr.updateSensitive(id, input));
}

export function useHrOrgChart() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.orgChart(), queryFn: () => weldhr.orgChart(), select: (r) => r.data });
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export function useHrDepartments() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.departments(), queryFn: () => weldhr.listDepartments(), select: (r) => r.data });
}

export function useCreateHrDepartment() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrDepartmentInput) => weldhr.createDepartment(input));
}

export function useUpdateHrDepartment() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<CreateHrDepartmentInput> & { id: string }) => weldhr.updateDepartment(id, input));
}

export function useDeleteHrDepartment() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteDepartment(id));
}

// ---------------------------------------------------------------------------
// Assignments & clients
// ---------------------------------------------------------------------------

export function useHrAssignments(params: { employeeId?: string; companyId?: string; active?: boolean }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.assignments(params), queryFn: () => weldhr.listAssignments(params), select: (r) => r.data });
}

export function useCreateHrAssignment() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrAssignmentInput) => weldhr.createAssignment(input));
}

export function useUpdateHrAssignment() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrAssignmentInput & { id: string }) => weldhr.updateAssignment(id, input));
}

export function useDeleteHrAssignment() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteAssignment(id));
}

export function useHrClients() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.clients(), queryFn: () => weldhr.listClients(), select: (r) => r.data });
}

export function useHrClient(companyId: string | undefined) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.client(companyId ?? ''),
    queryFn: () => weldhr.getClient(companyId as string),
    select: (r) => r.data,
    enabled: Boolean(companyId),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function useHrChecklistTemplates(kind?: 'onboarding' | 'offboarding') {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.templates(kind), queryFn: () => weldhr.listChecklistTemplates(kind), select: (r) => r.data });
}

export function useCreateHrChecklistTemplate() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrChecklistTemplateInput) => weldhr.createChecklistTemplate(input));
}

export function useUpdateHrChecklistTemplate() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<CreateHrChecklistTemplateInput> & { id: string }) =>
    weldhr.updateChecklistTemplate(id, input),
  );
}

export function useDeleteHrChecklistTemplate() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteChecklistTemplate(id));
}

export function useHrChecklists(params: { employeeId?: string; status?: string; kind?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.checklists(params), queryFn: () => weldhr.listChecklists(params), select: (r) => r.data });
}

export function useStartHrChecklist() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: { employeeId: string; templateId: string; anchorDate?: string }) => weldhr.startChecklist(input));
}

export function useCancelHrChecklist() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.cancelChecklist(id));
}

export function useDeleteHrChecklist() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteChecklist(id));
}

export function useAddHrChecklistTask() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ checklistId, ...input }: CreateHrChecklistTaskInput & { checklistId: string }) =>
    weldhr.addChecklistTask(checklistId, input),
  );
}

export function useUpdateHrChecklistTask() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrChecklistTaskInput & { id: string }) => weldhr.updateChecklistTask(id, input));
}

export function useDeleteHrChecklistTask() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteChecklistTask(id));
}

// ---------------------------------------------------------------------------
// Shifts & attendance
// ---------------------------------------------------------------------------

export function useHrShifts(params: { from?: string; to?: string; employeeId?: string; companyId?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.shifts(params), queryFn: () => weldhr.listShifts(params), select: (r) => r.data });
}

export function useCreateHrShift() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrShiftInput) => weldhr.createShift(input));
}

export function useUpdateHrShift() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<Omit<CreateHrShiftInput, 'employeeId'>> & { id: string }) => weldhr.updateShift(id, input));
}

export function useDeleteHrShift() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteShift(id));
}

export function useHrAttendance(params: HrAttendanceListParams) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.attendance(params),
    queryFn: () => weldhr.listAttendance(params),
    placeholderData: keepPreviousData,
  });
}

export function useHrAttendanceSummary(params: { from?: string; to?: string; employeeId?: string; companyId?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.attendanceSummary(params),
    queryFn: () => weldhr.attendanceSummary(params),
    select: (r) => r.data,
  });
}

export function useCreateHrAttendance() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrAttendanceInput) => weldhr.createAttendance(input));
}

export function useUpdateHrAttendance() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrAttendanceInput & { id: string }) => weldhr.updateAttendance(id, input));
}

export function useDeleteHrAttendance() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteAttendance(id));
}

export function useApproveHrAttendance() {
  const { weldhr } = useAppApi();
  return useHrMutation((ids: string[]) => weldhr.approveAttendance(ids));
}

export function useImportHrAttendance() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: ImportHrAttendanceInput) => weldhr.importAttendance(input));
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export function useHrLeaveTypes(includeInactive = false) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.leaveTypes(includeInactive),
    queryFn: () => weldhr.listLeaveTypes(includeInactive),
    select: (r) => r.data,
  });
}

export function useCreateHrLeaveType() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrLeaveTypeInput) => weldhr.createLeaveType(input));
}

export function useUpdateHrLeaveType() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<CreateHrLeaveTypeInput> & { id: string }) => weldhr.updateLeaveType(id, input));
}

export function useDeleteHrLeaveType() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteLeaveType(id));
}

export function useHrLeaveBalances(employeeId: string | undefined, year: number) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.leaveBalances(employeeId ?? '', year),
    queryFn: () => weldhr.leaveBalances(employeeId as string, year),
    select: (r) => r.data,
    enabled: Boolean(employeeId),
  });
}

export function useSetHrLeaveAllowance() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: { employeeId: string; leaveTypeId: string; year: number; days: number }) => weldhr.setLeaveAllowance(input));
}

export function useHrLeaveRequests(params: { employeeId?: string; status?: string; from?: string; to?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.leaveRequests(params), queryFn: () => weldhr.listLeaveRequests(params), select: (r) => r.data });
}

export function useCreateHrLeaveRequest() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrLeaveRequestInput) => weldhr.createLeaveRequest(input));
}

export function useReviewHrLeaveRequest() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: ReviewHrLeaveRequestInput & { id: string }) => weldhr.reviewLeaveRequest(id, input));
}

export function useCancelHrLeaveRequest() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.cancelLeaveRequest(id));
}

export function useDeleteHrLeaveRequest() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteLeaveRequest(id));
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

export function useHrCoaching(params: { employeeId?: string; companyId?: string; status?: string; category?: string; from?: string; to?: string; followUpDue?: boolean }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.coaching(params), queryFn: () => weldhr.listCoaching(params), select: (r) => r.data });
}

export function useCreateHrCoaching() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrCoachingLogInput) => weldhr.createCoaching(input));
}

export function useUpdateHrCoaching() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrCoachingLogInput & { id: string }) => weldhr.updateCoaching(id, input));
}

export function useDeleteHrCoaching() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteCoaching(id));
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export function useHrEvaluationForms() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.evaluationForms(), queryFn: () => weldhr.listEvaluationForms(), select: (r) => r.data });
}

export function useCreateHrEvaluationForm() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrEvaluationFormInput) => weldhr.createEvaluationForm(input));
}

export function useUpdateHrEvaluationForm() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<CreateHrEvaluationFormInput> & { id: string }) => weldhr.updateEvaluationForm(id, input));
}

export function useDeleteHrEvaluationForm() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteEvaluationForm(id));
}

export function useHrEvaluations(params: { employeeId?: string; companyId?: string; status?: string; formId?: string; from?: string; to?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.evaluations(params), queryFn: () => weldhr.listEvaluations(params), select: (r) => r.data });
}

export function useHrEvaluation(id: string | undefined) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.evaluation(id ?? ''),
    queryFn: () => weldhr.getEvaluation(id as string),
    select: (r) => r.data,
    enabled: Boolean(id),
  });
}

export function useCreateHrEvaluation() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrEvaluationInput) => weldhr.createEvaluation(input));
}

export function useUpdateHrEvaluation() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrEvaluationInput & { id: string }) => weldhr.updateEvaluation(id, input));
}

export function useDeleteHrEvaluation() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteEvaluation(id));
}

// ---------------------------------------------------------------------------
// KPIs & milestones
// ---------------------------------------------------------------------------

export function useHrKpis(params: { companyId?: string; includeInactive?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.kpis(params), queryFn: () => weldhr.listKpis(params), select: (r) => r.data });
}

export function useCreateHrKpi() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrKpiDefinitionInput) => weldhr.createKpi(input));
}

export function useUpdateHrKpi() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: Partial<CreateHrKpiDefinitionInput> & { id: string }) => weldhr.updateKpi(id, input));
}

export function useDeleteHrKpi() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteKpi(id));
}

export function useHrKpiValues(params: { employeeId?: string; kpiId?: string; companyId?: string; from?: string; to?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.kpiValues(params), queryFn: () => weldhr.listKpiValues(params), select: (r) => r.data });
}

export function useCreateHrKpiValue() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrKpiValueInput) => weldhr.createKpiValue(input));
}

export function useUpdateHrKpiValue() {
  const { weldhr } = useAppApi();
  return useHrMutation(
    ({ id, ...input }: Partial<Omit<CreateHrKpiValueInput, 'kpiId' | 'employeeId'>> & { id: string }) => weldhr.updateKpiValue(id, input),
  );
}

export function useDeleteHrKpiValue() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteKpiValue(id));
}

export function useImportHrKpiValues() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: ImportHrKpiValuesInput) => weldhr.importKpiValues(input));
}

export function useHrMilestones(params: { employeeId?: string; companyId?: string; status?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.milestones(params), queryFn: () => weldhr.listMilestones(params), select: (r) => r.data });
}

export function useCreateHrMilestone() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrMilestoneInput) => weldhr.createMilestone(input));
}

export function useUpdateHrMilestone() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrMilestoneInput & { id: string }) => weldhr.updateMilestone(id, input));
}

export function useDeleteHrMilestone() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteMilestone(id));
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

export function useHrPortalSettings() {
  const { weldhr } = useAppApi();
  return useQuery({ queryKey: weldhrKeys.portalSettings(), queryFn: () => weldhr.getPortalSettings(), select: (r) => r.data });
}

export function useUpdateHrPortalSettings() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: UpdateHrPortalSettingsInput) => weldhr.updatePortalSettings(input));
}

export function useHrPortalAccess(params: { kind?: 'employee' | 'client'; companyId?: string; employeeId?: string } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.portalAccess(params),
    queryFn: () => weldhr.listPortalAccess(params),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useInviteHrPortalAccess() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: InviteHrPortalAccessInput) => weldhr.invitePortalAccess(input));
}

export function useRevokeHrPortalAccess() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.revokePortalAccess(id));
}

export function useRestoreHrPortalAccess() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.restorePortalAccess(id));
}

export function useDeleteHrPortalAccess() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deletePortalAccess(id));
}
