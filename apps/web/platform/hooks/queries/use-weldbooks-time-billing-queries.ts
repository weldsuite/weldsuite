/**
 * Query hooks of time billing (phase 6): the unbilled time per customer,
 * invoicing it once, and a project's invoicing figures. Served by the Rust
 * backend only: gate the screens on `isTimeBillingAvailable()`.
 *
 * Keys sit under `['accounting', 'time-billing']`, so the entity switch resets
 * them with the rest.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  timeBillingApi,
  type InvoiceFromTimeInput,
  type UnbilledParams,
} from '@/lib/api/domains/weldbooks-time-billing';
import { isFeatureAvailable } from '@/lib/edition';
import { accountingKeys } from './use-accounting-queries';
import { projectKeys } from './use-projects-queries';
import { todoKeys } from './use-weldbooks-todo-queries';

/** Whether this deployment bills time (the Rust backend only). */
export function isTimeBillingAvailable(): boolean {
  return isFeatureAvailable('books-time-billing');
}

export const timeBillingKeys = {
  all: [...accountingKeys.all, 'time-billing'] as const,
  unbilled: (params: UnbilledParams) => [...timeBillingKeys.all, 'unbilled', params] as const,
  projectFinance: (projectId: string) => [...timeBillingKeys.all, 'project-finance', projectId] as const,
};

/** The billable time not on an invoice yet, per customer (and currency), with its entries. */
export function useUnbilledTime(params: UnbilledParams = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: timeBillingKeys.unbilled(params),
    queryFn: async () => (await timeBillingApi.unbilled(params)).data,
    enabled: (options.enabled ?? true) && isTimeBillingAvailable(),
  });
}

/** Invoiced, in draft and unbilled amounts of a project, and its costs. */
export function useProjectInvoicing(projectId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: timeBillingKeys.projectFinance(projectId),
    queryFn: async () => (await timeBillingApi.projectFinance(projectId)).data,
    enabled: !!projectId && (options.enabled ?? true) && isTimeBillingAvailable(),
  });
}

/**
 * What invoicing hours touches: the unbilled lists and the project figures, the invoices, the
 * customer's page, the time entries WeldFlow shows (now read-only), the to-process counts and the
 * overview.
 */
export function invalidateAfterTimeInvoice(qc: QueryClient, contactId?: string) {
  void qc.invalidateQueries({ queryKey: timeBillingKeys.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
  if (contactId) void qc.invalidateQueries({ queryKey: accountingKeys.customers.detail(contactId) });
  else void qc.invalidateQueries({ queryKey: accountingKeys.customers.all });
  void qc.invalidateQueries({ queryKey: todoKeys.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
  void qc.invalidateQueries({
    queryKey: projectKeys.all,
    predicate: (query) => query.queryKey.includes('time-entries'),
  });
}

/** Makes a draft invoice of the entries, or adds them to a draft of the same customer. */
export function useInvoiceFromTime(contactId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceFromTimeInput) => timeBillingApi.invoiceFromTime(input).then((res) => res.data),
    onSuccess: () => invalidateAfterTimeInvoice(qc, contactId),
    // A refusal (entries invoiced in the meantime) means the list is stale.
    onError: () => void qc.invalidateQueries({ queryKey: timeBillingKeys.all }),
  });
}
