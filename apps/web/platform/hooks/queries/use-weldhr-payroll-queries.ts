/**
 * WeldHR payroll hooks — employers, schedules, pay runs, payslips, filings, an
 * employee's payroll setup, and the signed-in employee's own payslips (My HR).
 *
 * Every key sits under ['weldhr', 'payroll'], inside the ['weldhr'] root that
 * the realtime sync map invalidates on hr_* events. Mutations invalidate the
 * whole payroll subtree: a run, its payslips, the overview and the employee
 * readiness list all move together (approving a run changes the filings due,
 * a profile change changes the readiness of the next run).
 *
 * Payslip PDFs, payment files and filing files are private responses behind the
 * session, so they are fetched as bytes and handed to the browser as a download
 * (same approach as `useOpenHrDeclarationReceipt`).
 */

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateHrCompensationInput,
  CreateHrPayComponentInput,
  CreateHrPayRunInput,
  CreateHrPayRunInputInput,
  CreateHrPayScheduleInput,
  CreateHrPayrollEmployerInput,
  CreateHrTaxElectionInput,
  HrPayrollEmployerBankInput,
  HrPayrollPaymentDetailsInput,
  MarkHrPayRunPaidInput,
  MarkHrPayrollFilingFiledInput,
  SetHrPayRunEmployeeInput,
  UpdateHrPayComponentInput,
  UpdateHrPayRunInput,
  UpdateHrPayRunInputInput,
  UpdateHrPayScheduleInput,
  UpdateHrPayrollEmployerInput,
  UpsertHrPayrollProfileInput,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';

export const payrollKeys = {
  all: ['weldhr', 'payroll'] as const,
  overview: () => [...payrollKeys.all, 'overview'] as const,
  employers: () => [...payrollKeys.all, 'employers'] as const,
  schedules: (params: object) => [...payrollKeys.all, 'schedules', params] as const,
  employees: (params: object) => [...payrollKeys.all, 'employees', params] as const,
  employee: (id: string) => [...payrollKeys.all, 'employee', id] as const,
  employeePayslips: (id: string) => [...payrollKeys.all, 'employee-payslips', id] as const,
  annualStatements: (id: string) => [...payrollKeys.all, 'annual-statements', id] as const,
  runs: (params: object) => [...payrollKeys.all, 'runs', params] as const,
  run: (id: string) => [...payrollKeys.all, 'run', id] as const,
  runInputs: (id: string, params: object) => [...payrollKeys.all, 'run-inputs', id, params] as const,
  payslip: (id: string) => [...payrollKeys.all, 'payslip', id] as const,
  filings: (params: object) => [...payrollKeys.all, 'filings', params] as const,
  me: (part: string) => [...payrollKeys.all, 'me', part] as const,
};

/** Mutation hook that invalidates the whole payroll cache on success. */
function usePayrollMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.all }),
  });
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * The `weldhr-payroll` flag, with its loading state (the payroll pages show a
 * loader rather than "not enabled" until the flags arrive). Same
 * `['feature-flags']` query and options as `useFeatureFlag`, so it is one
 * request and one cache entry. `enabled` is false while loading.
 */
export function useHrPayrollFlag() {
  const { featureFlags } = useAppApi();
  const query = useQuery({
    queryKey: ['feature-flags'],
    queryFn: async () => (await featureFlags.get()).data,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return { enabled: query.data?.['weldhr-payroll'] === true, isLoading: query.isLoading };
}

// ---------------------------------------------------------------------------
// Overview, employers, schedules
// ---------------------------------------------------------------------------

export function useHrPayrollOverview(opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.overview(),
    queryFn: () => weldhrPayroll.overview(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useHrPayrollEmployers(opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.employers(),
    queryFn: () => weldhrPayroll.listEmployers(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useCreateHrPayrollEmployer() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((input: CreateHrPayrollEmployerInput) => weldhrPayroll.createEmployer(input));
}

export function useUpdateHrPayrollEmployer() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: UpdateHrPayrollEmployerInput & { id: string }) => weldhrPayroll.updateEmployer(id, input));
}

export function useDeleteHrPayrollEmployer() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.deleteEmployer(id));
}

export function useSetHrPayrollEmployerBank() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: HrPayrollEmployerBankInput & { id: string }) => weldhrPayroll.setEmployerBank(id, input));
}

export function useHrPayrollSchedules(params: { employerId?: string } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.schedules(params),
    queryFn: () => weldhrPayroll.listSchedules(params),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useCreateHrPaySchedule() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((input: CreateHrPayScheduleInput) => weldhrPayroll.createSchedule(input));
}

export function useUpdateHrPaySchedule() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: UpdateHrPayScheduleInput & { id: string }) => weldhrPayroll.updateSchedule(id, input));
}

export function useDeleteHrPaySchedule() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.deleteSchedule(id));
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export function useHrPayrollEmployees(params: { employerId?: string; onPayroll?: boolean } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.employees(params),
    queryFn: () => weldhrPayroll.listEmployees(params),
    select: (r) => r.data,
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useHrPayrollEmployee(employeeId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.employee(employeeId ?? ''),
    queryFn: () => weldhrPayroll.getEmployee(employeeId as string),
    select: (r) => r.data,
    enabled: Boolean(employeeId) && (opts.enabled ?? true),
  });
}

export function useUpsertHrPayrollProfile() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ employeeId, ...input }: UpsertHrPayrollProfileInput & { employeeId: string }) =>
    weldhrPayroll.upsertProfile(employeeId, input),
  );
}

export function useSetHrPayrollPaymentDetails() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ employeeId, ...input }: HrPayrollPaymentDetailsInput & { employeeId: string }) =>
    weldhrPayroll.setPaymentDetails(employeeId, input),
  );
}

export function useCreateHrCompensation() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ employeeId, ...input }: CreateHrCompensationInput & { employeeId: string }) =>
    weldhrPayroll.createCompensation(employeeId, input),
  );
}

export function useDeleteHrCompensation() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.deleteCompensation(id));
}

export function useCreateHrPayComponent() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ employeeId, ...input }: CreateHrPayComponentInput & { employeeId: string }) =>
    weldhrPayroll.createComponent(employeeId, input),
  );
}

export function useUpdateHrPayComponent() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: UpdateHrPayComponentInput & { id: string }) => weldhrPayroll.updateComponent(id, input));
}

export function useDeleteHrPayComponent() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.deleteComponent(id));
}

export function useHrTaxElections(employeeId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: [...payrollKeys.all, 'tax-elections', employeeId ?? ''] as const,
    queryFn: () => weldhrPayroll.listTaxElections(employeeId as string),
    select: (r) => r.data,
    enabled: Boolean(employeeId) && (opts.enabled ?? true),
  });
}

export function useCreateHrTaxElection() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ employeeId, election }: { employeeId: string; election: CreateHrTaxElectionInput }) =>
    weldhrPayroll.createTaxElection(employeeId, election),
  );
}

export function useHrEmployeePayslips(employeeId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.employeePayslips(employeeId ?? ''),
    queryFn: () => weldhrPayroll.listEmployeePayslips(employeeId as string),
    select: (r) => r.data,
    enabled: Boolean(employeeId) && (opts.enabled ?? true),
  });
}

export function useHrAnnualStatements(employeeId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.annualStatements(employeeId ?? ''),
    queryFn: () => weldhrPayroll.listAnnualStatements(employeeId as string),
    select: (r) => r.data,
    enabled: Boolean(employeeId) && (opts.enabled ?? true),
  });
}

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

export function useHrPayRuns(params: { employerId?: string; status?: string; year?: number } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.runs(params),
    queryFn: () => weldhrPayroll.listRuns(params),
    select: (r) => r.data,
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useHrPayRun(id: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.run(id ?? ''),
    queryFn: () => weldhrPayroll.getRun(id as string),
    select: (r) => r.data,
    enabled: Boolean(id) && (opts.enabled ?? true),
  });
}

export function useCreateHrPayRun() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((input: CreateHrPayRunInput) => weldhrPayroll.createRun(input));
}

export function useUpdateHrPayRun() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: UpdateHrPayRunInput & { id: string }) => weldhrPayroll.updateRun(id, input));
}

export function useCancelHrPayRun() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.cancelRun(id));
}

export function useSetHrPayRunEmployee() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: SetHrPayRunEmployeeInput & { id: string }) => weldhrPayroll.setRunEmployee(id, input));
}

export function useCollectHrPayRunInputs() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.collectRunInputs(id));
}

export function useHrPayRunInputs(runId: string | undefined, params: { employeeId?: string } = {}, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.runInputs(runId ?? '', params),
    queryFn: () => weldhrPayroll.listRunInputs(runId as string, params),
    select: (r) => r.data,
    enabled: Boolean(runId) && (opts.enabled ?? true),
  });
}

export function useCreateHrPayRunInput() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ runId, ...input }: CreateHrPayRunInputInput & { runId: string }) => weldhrPayroll.createRunInput(runId, input));
}

export function useUpdateHrPayRunInput() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ runId, inputId, ...input }: UpdateHrPayRunInputInput & { runId: string; inputId: string }) =>
    weldhrPayroll.updateRunInput(runId, inputId, input),
  );
}

export function useDeleteHrPayRunInput() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ runId, inputId }: { runId: string; inputId: string }) => weldhrPayroll.deleteRunInput(runId, inputId));
}

export function useCalculateHrPayRun() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.calculateRun(id));
}

export function useApproveHrPayRun() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.approveRun(id));
}

export function useMarkHrPayRunPaid() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: MarkHrPayRunPaidInput & { id: string }) => weldhrPayroll.markRunPaid(id, input));
}

export function usePostHrPayRunJournal() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.postRunJournal(id));
}

export function useHrPayslip(id: string | undefined, opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.payslip(id ?? ''),
    queryFn: () => weldhrPayroll.getPayslip(id as string),
    select: (r) => r.data,
    enabled: Boolean(id) && (opts.enabled ?? true),
  });
}

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

export function useHrPayrollFilings(
  params: { employerId?: string; year?: number; status?: string; kind?: string } = {},
  opts: { enabled?: boolean } = {},
) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.filings(params),
    queryFn: () => weldhrPayroll.listFilings(params),
    select: (r) => r.data,
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useGenerateHrPayrollFiling() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.generateFiling(id));
}

export function useSubmitHrPayrollFiling() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.submitFiling(id));
}

export function useRefreshHrPayrollFilingStatus() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((id: string) => weldhrPayroll.refreshFilingStatus(id));
}

export function useMarkHrPayrollFilingFiled() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation(({ id, ...input }: MarkHrPayrollFilingFiledInput & { id: string }) => weldhrPayroll.markFilingFiled(id, input));
}

// ---------------------------------------------------------------------------
// Downloads (PDF, payment file, report, filing file)
// ---------------------------------------------------------------------------

/** The file name from a `Content-Disposition` header, if the response has one. */
function fileNameFromResponse(response: Response, fallback: string): string {
  const header = response.headers.get('content-disposition');
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // Some browsers cancel the download when the URL is revoked in the same tick.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One download mutation: fetch the response, then save it as `fileName` (the header's name wins). */
function useDownload<TInput>(fetcher: (input: TInput) => Promise<Response>, fileName: (input: TInput) => string) {
  return useMutation<void, Error, TInput>({
    mutationFn: async (input) => {
      const response = await fetcher(input);
      saveBlob(await response.blob(), fileNameFromResponse(response, fileName(input)));
    },
  });
}

export function useDownloadHrPayslipPdf() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ id }: { id: string; number?: string | null }) => weldhrPayroll.payslipPdf(id),
    ({ id, number }) => `payslip-${number ?? id}.pdf`,
  );
}

export function useDownloadHrPayRunPaymentFile() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ id }: { id: string; format: 'sepa' | 'nacha' }) => weldhrPayroll.runPaymentFile(id),
    ({ id, format }) => (format === 'sepa' ? `salary-${id}.xml` : `payroll-${id}.ach`),
  );
}

export function useDownloadHrPayRunReport() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    (id: string) => weldhrPayroll.runReport(id),
    (id) => `pay-run-${id}.csv`,
  );
}

export function useDownloadHrPayrollFilingFile() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ id }: { id: string; fileName?: string | null }) => weldhrPayroll.filingFile(id),
    ({ id, fileName }) => fileName ?? `filing-${id}`,
  );
}

export function useDownloadHrAnnualStatementPdf() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ employeeId, year, employerId }: { employeeId: string; year: number; employerId: string }) =>
      weldhrPayroll.annualStatementPdf(employeeId, year, employerId),
    ({ year }) => `annual-statement-${year}.pdf`,
  );
}

// ---------------------------------------------------------------------------
// My HR — the signed-in employee's own payroll. The employee is resolved from
// the session server-side; nothing here takes an employee id.
// ---------------------------------------------------------------------------

export function useMyPayslips(opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.me('payslips'),
    queryFn: () => weldhrPayroll.myPayslips(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyAnnualStatements(opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.me('annual-statements'),
    queryFn: () => weldhrPayroll.myAnnualStatements(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useMyPayrollDetails(opts: { enabled?: boolean } = {}) {
  const { weldhrPayroll } = useAppApi();
  return useQuery({
    queryKey: payrollKeys.me('details'),
    queryFn: () => weldhrPayroll.myPayrollDetails(),
    select: (r) => r.data,
    enabled: opts.enabled ?? true,
  });
}

export function useUpdateMyPayrollDetails() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((input: HrPayrollPaymentDetailsInput) => weldhrPayroll.updateMyPayrollDetails(input));
}

export function useSignMyTaxElection() {
  const { weldhrPayroll } = useAppApi();
  return usePayrollMutation((input: CreateHrTaxElectionInput) => weldhrPayroll.signMyTaxElection(input));
}

export function useDownloadMyPayslipPdf() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ id }: { id: string; number?: string | null }) => weldhrPayroll.myPayslipPdf(id),
    ({ id, number }) => `payslip-${number ?? id}.pdf`,
  );
}

export function useDownloadMyAnnualStatementPdf() {
  const { weldhrPayroll } = useAppApi();
  return useDownload(
    ({ year, employerId }: { year: number; employerId: string }) => weldhrPayroll.myAnnualStatementPdf(year, employerId),
    ({ year }) => `annual-statement-${year}.pdf`,
  );
}
