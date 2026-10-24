/**
 * Every WeldHR read and write the app makes. Queries share the `weldhr` key
 * root (see lib/query-client.ts); a successful write invalidates that root,
 * the same thing a realtime `hr_*` event does, so balances, badges and lists
 * all catch up at once.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client/client';
import type {
  HrSelfServiceAbsenceInput,
  HrSelfServiceDeclarationInput,
  HrSelfServiceLeaveRequestInput,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

import { NO_ACCESS, resolveAccess, type HrAccess } from '@/lib/access';
import { addDays, todayIso } from '@/lib/dates';
import { weldhrKeys } from '@/lib/query-client';
import { appApi } from '@/services/app-api';
import { uploadReceipt, type LocalReceipt } from '@/utils/receipt';

function useInvalidateWeldHr() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: weldhrKeys.all });
}

/** True for the 404 an hr-api endpoint answers when a feature flag is off or the record is missing. */
export function isNotFound(err: unknown): boolean {
  return isApiError(err) && err.status === 404;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function useHrAccess(): { access: HrAccess; isLoading: boolean } {
  const { user, organizationId } = useClerkAuth();
  const query = useQuery({
    queryKey: [...weldhrKeys.access(), organizationId ?? ''],
    queryFn: async () => {
      const { data } = await appApi.me.permissions();
      return resolveAccess({ permissions: data.permissions ?? [], denies: data.denies }, Boolean(data.appEnforced));
    },
    enabled: Boolean(user && organizationId),
    staleTime: 5 * 60_000,
    retry: 3,
  });
  return { access: query.data ?? NO_ACCESS, isLoading: query.isPending };
}

// ---------------------------------------------------------------------------
// My HR
// ---------------------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: weldhrKeys.me(),
    queryFn: async () => (await appApi.weldhr.me()).data,
  });
}

export function useOverview(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.overview(),
    queryFn: async () => (await appApi.weldhr.meOverview()).data,
    enabled,
  });
}

export function useAttendance(daysBack = 30, daysAhead = 14) {
  const today = todayIso();
  const from = addDays(today, -daysBack);
  const to = addDays(today, daysAhead);
  return useQuery({
    queryKey: weldhrKeys.attendance(from, to),
    queryFn: async () => (await appApi.weldhr.meAttendance({ from, to })).data,
  });
}

export function useClock() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: (action: 'in' | 'out') => appApi.weldhr.meClock({ action }),
    onSuccess: invalidate,
  });
}

export function useLeave() {
  return useQuery({
    queryKey: weldhrKeys.leave(),
    queryFn: async () => (await appApi.weldhr.meLeave()).data,
  });
}

export function useRequestLeave() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: (body: HrSelfServiceLeaveRequestInput) => appApi.weldhr.meRequestLeave(body),
    onSuccess: invalidate,
  });
}

export function useCancelLeave() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: (id: string) => appApi.weldhr.meCancelLeave(id),
    onSuccess: invalidate,
  });
}

export function useAbsences() {
  return useQuery({
    queryKey: weldhrKeys.absences(),
    queryFn: async () => (await appApi.weldhr.meAbsences()).data,
  });
}

export function useReportSick() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: (body: HrSelfServiceAbsenceInput) => appApi.weldhr.meReportSick(body),
    onSuccess: invalidate,
  });
}

export function useReportRecovered() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: ({ id, endDate }: { id: string; endDate: string }) => appApi.weldhr.meReportRecovered(id, { endDate }),
    onSuccess: invalidate,
  });
}

export function useDeclarations() {
  return useQuery({
    queryKey: weldhrKeys.declarations(),
    queryFn: async () => (await appApi.weldhr.meDeclarations()).data,
  });
}

/**
 * File a declaration, then attach the receipt. The two are separate calls on
 * the API; when only the upload fails the claim still stands, so the result
 * says so instead of throwing.
 */
export function useCreateDeclaration() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: async ({ body, receipt }: { body: HrSelfServiceDeclarationInput; receipt: LocalReceipt | null }) => {
      const { data } = await appApi.weldhr.meCreateDeclaration(body);
      if (!receipt) return { declaration: data, receiptFailed: false };
      try {
        await uploadReceipt(data.id, receipt);
        return { declaration: data, receiptFailed: false };
      } catch {
        return { declaration: data, receiptFailed: true };
      }
    },
    onSuccess: invalidate,
  });
}

export function useCancelDeclaration() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: (id: string) => appApi.weldhr.meCancelDeclaration(id),
    onSuccess: invalidate,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: weldhrKeys.tasks(),
    queryFn: async () => (await appApi.weldhr.meTasks()).data,
  });
}

export function useCompleteTask() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => appApi.weldhr.meCompleteTask(id, done),
    onSuccess: invalidate,
  });
}

export function useCoaching() {
  return useQuery({
    queryKey: weldhrKeys.coaching(),
    queryFn: async () => (await appApi.weldhr.meCoaching()).data,
  });
}

export function useEvaluations() {
  return useQuery({
    queryKey: weldhrKeys.evaluations(),
    queryFn: async () => (await appApi.weldhr.meEvaluations()).data,
  });
}

export function useAcknowledge() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: ({ kind, id, comment }: { kind: 'coaching' | 'evaluation'; id: string; comment: string | null }) =>
      kind === 'coaching'
        ? appApi.weldhr.meAcknowledgeCoaching(id, { comment })
        : appApi.weldhr.meAcknowledgeEvaluation(id, { comment }),
    onSuccess: invalidate,
  });
}

/**
 * Final payslips. `null` when payroll is not switched on for the workspace
 * (hr-api answers 404 while the `weldhr-payroll` flag is off), so the Pay
 * tab can hide itself instead of showing an error.
 */
export function usePayslips(enabled = true) {
  return useQuery({
    queryKey: weldhrKeys.payslips(),
    queryFn: async () => {
      try {
        return (await appApi.payroll.myPayslips()).data;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useAnnualStatements(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.annualStatements(),
    queryFn: async () => {
      try {
        return (await appApi.payroll.myAnnualStatements()).data;
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
    },
    enabled,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Team (workspace permissions, not My HR)
// ---------------------------------------------------------------------------

export function useTeamDashboard(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.dashboard(),
    queryFn: async () => (await appApi.weldhr.dashboard()).data,
    enabled,
  });
}

export function usePendingLeave(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.pendingLeave(),
    queryFn: async () => (await appApi.weldhr.listLeaveRequests({ status: 'pending' })).data,
    enabled,
  });
}

export function usePendingExpenses(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.pendingExpenses(),
    queryFn: async () => (await appApi.weldhr.listDeclarations({ status: 'pending' })).data,
    enabled,
  });
}

export function useSickToday(enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.sickToday(),
    queryFn: async () => (await appApi.weldhr.listAbsences({ status: 'ongoing', limit: 50 })).data,
    enabled,
  });
}

/** Everyone still on the books: the directory leaves out terminated employees. */
const CURRENT_STATUSES = 'onboarding,active,on_leave,offboarding';

export function useEmployees(search: string, enabled: boolean) {
  return useQuery({
    queryKey: weldhrKeys.employees(search),
    queryFn: async () =>
      (await appApi.weldhr.listEmployees({ search: search || undefined, status: CURRENT_STATUSES, limit: 100 })).data,
    enabled,
  });
}

export type ReviewDecision = 'approved' | 'rejected';

export function useReviewLeave() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: ReviewDecision; note?: string | null }) =>
      appApi.weldhr.reviewLeaveRequest(id, { decision, note: note || null }),
    onSuccess: invalidate,
  });
}

export function useReviewExpense() {
  const invalidate = useInvalidateWeldHr();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: ReviewDecision; note?: string | null }) =>
      appApi.weldhr.reviewDeclaration(id, { decision, note: note || null }),
    onSuccess: invalidate,
  });
}
