/**
 * WeldBooks bank feed queries and mutations.
 *
 * Keys live under `['accounting', 'bank-feeds', ...]`, so the entity switch
 * resets them with the other entity-scoped accounting data
 * (`isEntityScopedAccountingQuery`): a connection belongs to one entity.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  bankFeedsApi,
  type BankFeedCompleteInput,
  type BankFeedLinkSessionInput,
  type BankFeedMapAccountsInput,
} from '@/lib/api/domains/weldbooks-bank-feeds';
import { accountingKeys } from '@/hooks/queries/use-accounting-queries';

export const bankFeedKeys = {
  all: ['accounting', 'bank-feeds'] as const,
  connections: () => [...bankFeedKeys.all, 'connections'] as const,
  providers: (country?: string) => [...bankFeedKeys.all, 'providers', country ?? 'entity'] as const,
  institutions: (provider: string, country: string) =>
    [...bankFeedKeys.all, 'institutions', provider, country] as const,
  pending: (connectionId: string, bankAccountId?: string) =>
    [...bankFeedKeys.all, 'pending', connectionId, bankAccountId ?? 'all'] as const,
};

/** What a feed changes in the books: the bank accounts, their transactions, the dashboard balances. */
function invalidateBooks(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

/** Linked accounts sync in the background after mapping: look again a little later. */
const FIRST_SYNC_REFRESH_MS = [4_000, 12_000] as const;

// ============================================================================
// Queries
// ============================================================================

export function useBankFeedConnections(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bankFeedKeys.connections(),
    queryFn: () => bankFeedsApi.listConnections(),
    enabled: options.enabled ?? true,
  });
}

/** Providers the entity's country can use. Without `country` the server uses the entity's jurisdiction. */
export function useBankFeedProviders(country?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bankFeedKeys.providers(country),
    queryFn: () => bankFeedsApi.listProviders(country),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

/** Banks a redirect provider can link (Enable Banking). */
export function useBankFeedInstitutions(
  provider: string | null | undefined,
  country: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: bankFeedKeys.institutions(provider ?? '', country ?? ''),
    queryFn: () => bankFeedsApi.listInstitutions(provider!, country!),
    enabled: (options.enabled ?? true) && !!provider && !!country,
    staleTime: 60 * 60 * 1000,
  });
}

export function useBankFeedPendingTransactions(
  connectionId: string | null | undefined,
  bankAccountId?: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: bankFeedKeys.pending(connectionId ?? '', bankAccountId),
    queryFn: () => bankFeedsApi.listPendingTransactions(connectionId!, bankAccountId),
    enabled: (options.enabled ?? true) && !!connectionId,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useCreateBankFeedLinkSession() {
  return useMutation({
    mutationFn: (input: BankFeedLinkSessionInput) => bankFeedsApi.createLinkSession(input),
  });
}

export function useCompleteBankFeedLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankFeedCompleteInput) => bankFeedsApi.completeLink(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankFeedKeys.connections() });
      // A relink reattaches existing bank accounts to the new provider account ids.
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}

export function useMapBankFeedAccounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, input }: { connectionId: string; input: BankFeedMapAccountsInput }) =>
      bankFeedsApi.mapAccounts(connectionId, input),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: bankFeedKeys.connections() });
      invalidateBooks(qc);
      if (result.syncStarted) {
        for (const delay of FIRST_SYNC_REFRESH_MS) {
          setTimeout(() => {
            qc.invalidateQueries({ queryKey: bankFeedKeys.all });
            invalidateBooks(qc);
          }, delay);
        }
      }
    },
  });
}

export function useSyncBankFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, refresh }: { connectionId: string; refresh?: boolean }) =>
      bankFeedsApi.syncConnection(connectionId, { refresh }),
    // A provider error still answers 200, and the connection status may have moved: always look again.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: bankFeedKeys.all });
      invalidateBooks(qc);
    },
  });
}

export function useDisconnectBankFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => bankFeedsApi.disconnectConnection(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankFeedKeys.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}

export function useDeleteBankFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => bankFeedsApi.deleteConnection(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankFeedKeys.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}
