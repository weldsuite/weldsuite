/**
 * Query hooks of the entity's online payment connection (phase 4b). Served by
 * the Rust backend only: gate the screens on `isOnlinePaymentsAvailable()`.
 *
 * Keys sit under `['accounting', ...]`, so the entity switch resets them with
 * the rest. They are spelled out here (the same prefixes as `accountingKeys`),
 * so screens that only show a Mollie label load this module without that one. Every change drops what it touches: the connection, the invoices
 * (their payment state), the bank accounts (the Mollie account appears on first
 * use), the bank lines and To process (settlement lines that could not be booked).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { paymentsApi } from '@/lib/api/domains/weldbooks-payments';
import { isFeatureAvailable } from '@/lib/edition';

/** Whether this deployment takes online payments through Mollie (the Rust backend only). */
export function isOnlinePaymentsAvailable(): boolean {
  return isFeatureAvailable('books-online-payments');
}

export const paymentKeys = {
  all: ['accounting', 'payment-connection'] as const,
  connection: () => [...paymentKeys.all, 'current'] as const,
  methods: (id: string) => [...paymentKeys.all, 'methods', id] as const,
};

/** The to-process queries (`todoKeys.all` in `use-weldbooks-todo-queries.ts`), named here so this module loads without that one. */
const TODO_QUERIES = ['accounting', 'todo'] as const;
const INVOICE_QUERIES = ['accounting', 'invoices'] as const;
const BANK_ACCOUNT_QUERIES = ['accounting', 'bank-accounts'] as const;
const BANK_LINE_QUERIES = ['accounting', 'bank-transactions'] as const;

function invalidateConnection(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: paymentKeys.all });
  void qc.invalidateQueries({ queryKey: INVOICE_QUERIES });
  void qc.invalidateQueries({ queryKey: BANK_ACCOUNT_QUERIES });
  void qc.invalidateQueries({ queryKey: BANK_LINE_QUERIES });
  void qc.invalidateQueries({ queryKey: TODO_QUERIES });
}

/** The entity's connection, or `null` when it has none. */
export function usePaymentConnection(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentKeys.connection(),
    queryFn: async () => (await paymentsApi.getConnection()).data,
    enabled: (options.enabled ?? true) && isOnlinePaymentsAvailable(),
    staleTime: 30_000,
  });
}

/** The methods the Mollie profile has switched on, for the picker. */
export function useMollieMethods(connectionId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentKeys.methods(connectionId ?? ''),
    queryFn: async () => (await paymentsApi.listMethods(connectionId ?? '')).data,
    enabled: (options.enabled ?? true) && Boolean(connectionId) && isOnlinePaymentsAvailable(),
    staleTime: 60_000,
  });
}

/** Asks for the Mollie Connect address; the caller redirects the browser to it. */
export function useAuthorizeMollie() {
  return useMutation({
    mutationFn: (returnUrl: string) => paymentsApi.authorizeMollie(returnUrl),
  });
}

export function useConnectMollieApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { apiKey: string; profileId?: string }) => paymentsApi.connectWithApiKey(input),
    onSuccess: () => invalidateConnection(qc),
  });
}

export function useUpdatePaymentMethods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, methods }: { id: string; methods: string[] }) => paymentsApi.updateConnection(id, { methods }),
    onSuccess: (res) => {
      qc.setQueryData(paymentKeys.connection(), res.data);
      invalidateConnection(qc);
    },
  });
}

export function useDisconnectMollie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => paymentsApi.disconnect(id),
    onSuccess: () => invalidateConnection(qc),
  });
}

export function useSyncSettlements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => paymentsApi.syncSettlements(id),
    onSuccess: () => invalidateConnection(qc),
  });
}
