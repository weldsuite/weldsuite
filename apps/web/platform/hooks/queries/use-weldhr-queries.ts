/**
 * WeldHR hooks — employees, time, the workforce portal settings and My HR.
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
  HrAbsenceListParams,
  HrAttendanceListParams,
  HrEmployeeListParams,
} from '@weldsuite/app-api-client/domains/weldhr';
import type {
  CreateHrAbsenceInput,
  CreateHrAttendanceInput,
  CreateHrDepartmentInput,
  CreateHrEmployeeFromMemberInput,
  CreateHrEmployeeInput,
  CreateHrLeaveRequestInput,
  CreateHrLeaveTypeInput,
  CreateHrShiftInput,
  HrEmployeeSensitiveInput,
  HrSelfServiceAbsenceInput,
  HrSelfServiceAcknowledgeInput,
  HrSelfServiceClockInput,
  HrSelfServiceLeaveRequestInput,
  ImportHrAttendanceInput,
  InviteHrPortalAccessInput,
  RecoverHrAbsenceInput,
  ReviewHrLeaveRequestInput,
  UpdateHrAbsenceInput,
  UpdateHrAttendanceInput,
  UpdateHrEmployeeInput,
  UpdateHrPortalSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldhr';

export const weldhrKeys = {
  all: ['weldhr'] as const,
  dashboard: () => [...weldhrKeys.all, 'dashboard'] as const,
  employees: (params: HrEmployeeListParams) => [...weldhrKeys.all, 'employees', params] as const,
  employee: (id: string) => [...weldhrKeys.all, 'employee', id] as const,
  sensitive: (id: string) => [...weldhrKeys.all, 'sensitive', id] as const,
  departments: () => [...weldhrKeys.all, 'departments'] as const,
  shifts: (params: object) => [...weldhrKeys.all, 'shifts', params] as const,
  attendance: (params: object) => [...weldhrKeys.all, 'attendance', params] as const,
  attendanceSummary: (params: object) => [...weldhrKeys.all, 'attendance-summary', params] as const,
  leaveTypes: (includeInactive: boolean) => [...weldhrKeys.all, 'leave-types', includeInactive] as const,
  leaveBalances: (employeeId: string, year: number) => [...weldhrKeys.all, 'leave-balances', employeeId, year] as const,
  leaveRequests: (params: object) => [...weldhrKeys.all, 'leave-requests', params] as const,
  absences: (params: object) => [...weldhrKeys.all, 'absences', params] as const,
  portalSettings: () => [...weldhrKeys.all, 'portal-settings'] as const,
  portalAccess: (params: object) => [...weldhrKeys.all, 'portal-access', params] as const,
  availableMembers: (params: object) => [...weldhrKeys.all, 'available-members', params] as const,
  me: (part: string, params: object = {}) => [...weldhrKeys.all, 'me', part, params] as const,
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

export function useCreateHrEmployeeFromMember() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrEmployeeFromMemberInput) => weldhr.createEmployeeFromMember(input));
}

/** Workspace members who can still become an employee (active, INTERNAL or EMPLOYEE, unlinked). */
export function useHrAvailableMembers(params: { search?: string; limit?: number } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.availableMembers(params),
    queryFn: () => weldhr.listAvailableMembers(params),
    select: (r) => r.data,
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
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

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export function useHrDepartments(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.departments(),
    queryFn: () => weldhr.listDepartments(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
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
// Shifts & attendance
// ---------------------------------------------------------------------------

export function useHrShifts(params: { from?: string; to?: string; employeeId?: string; companyId?: string }) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.shifts(params),
    queryFn: () => weldhr.listShifts(params),
    select: (r) => r.data,
    // Paging through periods keeps the grid on screen instead of flashing a loader.
    placeholderData: keepPreviousData,
  });
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
// Sick reports (back office; an employee's own reports are under My HR below)
// ---------------------------------------------------------------------------

export function useHrAbsences(params: HrAbsenceListParams, opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.absences(params),
    queryFn: () => weldhr.listAbsences(params),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useCreateHrAbsence() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: CreateHrAbsenceInput) => weldhr.createAbsence(input));
}

export function useUpdateHrAbsence() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: UpdateHrAbsenceInput & { id: string }) => weldhr.updateAbsence(id, input));
}

export function useRecoverHrAbsence() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: RecoverHrAbsenceInput & { id: string }) => weldhr.recoverAbsence(id, input));
}

export function useDeleteHrAbsence() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.deleteAbsence(id));
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

// ---------------------------------------------------------------------------
// My HR — the signed-in member's own employee record. Every endpoint resolves
// the employee from the session server-side; nothing here takes an id for
// the employee.
// ---------------------------------------------------------------------------

/** `employee: null` when the member has no (or a terminated) employee record. */
export function useMyHr(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('self'),
    queryFn: () => weldhr.me(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
    staleTime: 60 * 1000,
  });
}

export function useMyHrOverview(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('overview'),
    queryFn: () => weldhr.meOverview(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrAttendance(params: { from?: string; to?: string } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('attendance', params),
    queryFn: () => weldhr.meAttendance(params),
    select: (r) => r.data,
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrClock() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: HrSelfServiceClockInput) => weldhr.meClock(input));
}

export function useMyHrLeave(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('leave'),
    queryFn: () => weldhr.meLeave(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrRequestLeave() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: HrSelfServiceLeaveRequestInput) => weldhr.meRequestLeave(input));
}

export function useMyHrCancelLeave() {
  const { weldhr } = useAppApi();
  return useHrMutation((id: string) => weldhr.meCancelLeave(id));
}

export function useMyHrAbsences(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('absences'),
    queryFn: () => weldhr.meAbsences(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrReportSick() {
  const { weldhr } = useAppApi();
  return useHrMutation((input: HrSelfServiceAbsenceInput) => weldhr.meReportSick(input));
}

export function useMyHrReportRecovered() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: RecoverHrAbsenceInput & { id: string }) => weldhr.meReportRecovered(id, input));
}

export function useMyHrTasks(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('tasks'),
    queryFn: () => weldhr.meTasks(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrCompleteTask() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, done }: { id: string; done: boolean }) => weldhr.meCompleteTask(id, done));
}

export function useMyHrCoaching(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('coaching'),
    queryFn: () => weldhr.meCoaching(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrAcknowledgeCoaching() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: HrSelfServiceAcknowledgeInput & { id: string }) => weldhr.meAcknowledgeCoaching(id, input));
}

export function useMyHrEvaluations(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('evaluations'),
    queryFn: () => weldhr.meEvaluations(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyHrAcknowledgeEvaluation() {
  const { weldhr } = useAppApi();
  return useHrMutation(({ id, ...input }: HrSelfServiceAcknowledgeInput & { id: string }) => weldhr.meAcknowledgeEvaluation(id, input));
}

export function useMyHrPerformance(opts: { enabled?: boolean } = {}) {
  const { weldhr } = useAppApi();
  return useQuery({
    queryKey: weldhrKeys.me('performance'),
    queryFn: () => weldhr.mePerformance(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}
