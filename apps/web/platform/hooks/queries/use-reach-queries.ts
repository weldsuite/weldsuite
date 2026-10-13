/**
 * WeldReach hooks: access and usage, overview, settings, billing, domains,
 * mailboxes and suppressions. The campaign, prospect and reply-inbox hooks
 * live in their own files and build their keys on `reachKeys` too, so the
 * realtime sync map (`reach_*` topics invalidate `['reach']`) refreshes them all.
 *
 * Every route is refused with 403 APP_ACCESS_REQUIRED until WeldSuite staff
 * have approved the workspace; the module layout turns that into an
 * explanation screen, so these hooks do not retry it.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isAppAccessRequiredError } from '@/lib/reach/errors';
import type {
  ConnectReachDomainInput,
  CreateReachMailboxInput,
  ReachBillingSetupInput,
  ReachMailboxStatus,
  UpdateReachMailboxInput,
  UpdateReachSettingsInput,
} from '@weldsuite/app-api-client/schemas/reach';

export const reachKeys = {
  all: ['reach'] as const,
  access: () => [...reachKeys.all, 'access'] as const,
  overview: () => [...reachKeys.all, 'overview'] as const,
  settings: () => [...reachKeys.all, 'settings'] as const,
  billing: () => [...reachKeys.all, 'billing'] as const,
  domains: () => [...reachKeys.all, 'domains'] as const,
  domainCandidates: () => [...reachKeys.all, 'domain-candidates'] as const,
  mailboxes: (params?: { domainId?: string; status?: ReachMailboxStatus }) =>
    [...reachKeys.all, 'mailboxes', params ?? {}] as const,
  suppressions: (search?: string) => [...reachKeys.all, 'suppressions', search ?? ''] as const,
  // Shared with the campaign, prospect and inbox hooks.
  campaigns: (params?: Record<string, unknown>) => [...reachKeys.all, 'campaigns', params ?? {}] as const,
  campaign: (id: string) => [...reachKeys.all, 'campaign', id] as const,
  campaignEnrollments: (id: string, params?: Record<string, unknown>) =>
    [...reachKeys.all, 'campaign', id, 'enrollments', params ?? {}] as const,
  campaignStepStats: (id: string) => [...reachKeys.all, 'campaign', id, 'step-stats'] as const,
  prospects: (params?: Record<string, unknown>) => [...reachKeys.all, 'prospects', params ?? {}] as const,
  prospectLists: () => [...reachKeys.all, 'prospect-lists'] as const,
  inbox: (filter?: Record<string, unknown>) => [...reachKeys.all, 'inbox', filter ?? {}] as const,
  thread: (threadKey: string) => [...reachKeys.all, 'thread', threadKey] as const,
  unreadCount: () => [...reachKeys.all, 'unread-count'] as const,
};

/** A 403 APP_ACCESS_REQUIRED is an answer, not a transient failure: never retry it. */
function retryUnlessAccessRefused(failureCount: number, error: unknown): boolean {
  return !isAppAccessRequiredError(error) && failureCount < 2;
}

// ---------------------------------------------------------------------------
// Access, overview, settings
// ---------------------------------------------------------------------------

/**
 * Status, limits and live usage. Also the module's gate: the layout shows the
 * pending / rejected / suspended explanation when this answers 403.
 */
export function useReachAccess() {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.access(),
    queryFn: () => reach.access(),
    select: (res) => res.data,
    retry: retryUnlessAccessRefused,
    // A suspension reaches a workspace that already has the module open.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
}

export function useReachOverview() {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.overview(),
    queryFn: () => reach.overview(),
    select: (res) => res.data,
    retry: retryUnlessAccessRefused,
  });
}

export function useReachSettings(enabled = true) {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.settings(),
    queryFn: () => reach.getSettings(),
    select: (res) => res.data,
    enabled,
    retry: retryUnlessAccessRefused,
  });
}

export function useUpdateReachSettings() {
  const { reach } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateReachSettingsInput) => reach.updateSettings(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachKeys.settings() });
      void qc.invalidateQueries({ queryKey: reachKeys.overview() });
    },
  });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export function useReachBilling(enabled = true) {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.billing(),
    queryFn: () => reach.billing(),
    select: (res) => res.data,
    enabled,
    retry: retryUnlessAccessRefused,
  });
}

/** Opens Stripe Checkout (setup mode); the caller redirects to the returned url. */
export function useReachBillingSetup() {
  const { reach } = useAppApi();
  return useMutation({
    mutationFn: (input: ReachBillingSetupInput) => reach.billingSetup(input),
  });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export function useReachDomains() {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.domains(),
    queryFn: () => reach.listDomains(),
    select: (res) => res.data,
    retry: retryUnlessAccessRefused,
  });
}

/** The workspace's WeldHost domains and whether each can be connected. */
export function useReachDomainCandidates(enabled = true) {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.domainCandidates(),
    queryFn: () => reach.domainCandidates(),
    select: (res) => res.data,
    enabled,
    retry: retryUnlessAccessRefused,
  });
}

function useInvalidateAfterDomainChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: reachKeys.domains() });
    void qc.invalidateQueries({ queryKey: reachKeys.domainCandidates() });
    void qc.invalidateQueries({ queryKey: reachKeys.mailboxes() });
    void qc.invalidateQueries({ queryKey: reachKeys.access() });
  };
}

export function useConnectReachDomain() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterDomainChange();
  return useMutation({
    mutationFn: (input: ConnectReachDomainInput) => reach.connectDomain(input),
    onSuccess: invalidate,
  });
}

export function useRefreshReachDomainDns() {
  const { reach } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reach.refreshDomainDns(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachKeys.domains() });
    },
  });
}

export function useDisconnectReachDomain() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterDomainChange();
  return useMutation({
    mutationFn: (id: string) => reach.disconnectDomain(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export function useReachMailboxes(params: { domainId?: string; status?: ReachMailboxStatus } = {}) {
  const { reach } = useAppApi();
  return useQuery({
    queryKey: reachKeys.mailboxes(params),
    queryFn: () => reach.listMailboxes(params),
    select: (res) => res.data,
    retry: retryUnlessAccessRefused,
  });
}

/** Mailbox writes change usage, the domain's mailbox count, the overview and the monthly bill. */
function useInvalidateAfterMailboxChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...reachKeys.all, 'mailboxes'] });
    void qc.invalidateQueries({ queryKey: reachKeys.domains() });
    void qc.invalidateQueries({ queryKey: reachKeys.overview() });
    void qc.invalidateQueries({ queryKey: reachKeys.access() });
    void qc.invalidateQueries({ queryKey: reachKeys.billing() });
  };
}

export function useCreateReachMailbox() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterMailboxChange();
  return useMutation({
    mutationFn: (input: CreateReachMailboxInput) => reach.createMailbox(input),
    onSuccess: invalidate,
  });
}

export function useUpdateReachMailbox() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterMailboxChange();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateReachMailboxInput }) => reach.updateMailbox(id, input),
    onSuccess: invalidate,
  });
}

export function usePauseReachMailbox() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterMailboxChange();
  return useMutation({
    mutationFn: (id: string) => reach.pauseMailbox(id),
    onSuccess: invalidate,
  });
}

export function useResumeReachMailbox() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterMailboxChange();
  return useMutation({
    mutationFn: (id: string) => reach.resumeMailbox(id),
    onSuccess: invalidate,
  });
}

export function useDeleteReachMailbox() {
  const { reach } = useAppApi();
  const invalidate = useInvalidateAfterMailboxChange();
  return useMutation({
    mutationFn: (id: string) => reach.deleteMailbox(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

const SUPPRESSION_PAGE_SIZE = 50;

/** Cursor-paged suppression list; `search` filters server-side. */
export function useReachSuppressions(search = '') {
  const { reach } = useAppApi();
  const term = search.trim();
  return useInfiniteQuery({
    queryKey: reachKeys.suppressions(term),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      reach.listSuppressions({ cursor: pageParam, limit: SUPPRESSION_PAGE_SIZE, search: term || undefined }),
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    retry: retryUnlessAccessRefused,
  });
}

export function useAddReachSuppressions() {
  const { reach } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: string[]) => reach.addSuppressions(values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...reachKeys.all, 'suppressions'] });
    },
  });
}

export function useDeleteReachSuppression() {
  const { reach } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reach.deleteSuppression(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...reachKeys.all, 'suppressions'] });
    },
  });
}
