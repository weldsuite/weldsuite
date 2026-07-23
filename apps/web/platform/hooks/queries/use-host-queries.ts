
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  Domain,
  DomainListResponse,
  DashboardStats,
  ChartDataPoint,
  CheckoutInput,
  CheckoutResponse,
  ExternalDomainInput,
  CreateDomainInput,
  UpdateDomainInput,
  RegistrationStatusResponse,
} from '@weldsuite/core-api-client/schemas/domains';
import type {
  DnsRecord as DnsRecordSchema,
  DnsRecordsListResponse,
  DnsRecordsMutationResponse,
  SyncDnsRecordsResponse,
  ScannedDnsRecord as SchemaScannedDnsRecord,
  CreateDnsRecordInput as SchemaCreateDnsRecordInput,
  DnsRecordLock,
} from '@weldsuite/core-api-client/schemas/dns-records';
import type { DnsZone, CreateDnsZoneInput } from '@weldsuite/core-api-client/schemas/dns-zones';

// =============================================================================
// Query Keys
// =============================================================================

const hostKeys = {
  all: ['host'] as const,
  domains: () => [...hostKeys.all, 'domains'] as const,
  domainList: (filters?: Record<string, any>) => [...hostKeys.domains(), 'list', filters] as const,
  domain: (id: string) => [...hostKeys.all, 'domains', id] as const,
  dnsZones: (domainId: string) => [...hostKeys.all, 'domains', domainId, 'dns'] as const,
  dnsRecords: (domainId: string) => [...hostKeys.all, 'domains', domainId, 'dns', 'records'] as const,
  dashboard: () => [...hostKeys.all, 'dashboard'] as const,
  dashboardChart: (days?: number) => [...hostKeys.all, 'dashboard', 'chart', days] as const,
  dashboardRecent: (limit?: number) => [...hostKeys.all, 'dashboard', 'recent', limit] as const,
  domainPricingByTld: (tld: string) => [...hostKeys.all, 'pricing', tld] as const,
  transfer: (id: string) => [...hostKeys.all, 'transfers', id] as const,
  registrationStatus: (id: string) => [...hostKeys.all, 'registrations', id, 'status'] as const,
};

// =============================================================================
// Domain queries — app-api (/api/domains)
// =============================================================================

export function useDomains(filters?: {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
}) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.domainList(filters),
    queryFn: () => domains.list(filters as never) as Promise<DomainListResponse>,
  });
}

export function useDomain(id: string, enabled = true) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.domain(id),
    queryFn: () => domains.get(id),
    enabled: !!id && enabled,
  });
}

function useDashboardStats() {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.dashboard(),
    queryFn: () => domains.dashboard() as Promise<{ data: DashboardStats }>,
  });
}

function useDashboardChartData(days: number = 90) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.dashboardChart(days),
    queryFn: () => domains.dashboardChart(days) as Promise<{ data: ChartDataPoint[] }>,
  });
}

function useDashboardRecentDomains(limit: number = 10) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.dashboardRecent(limit),
    queryFn: () => domains.dashboardRecent(limit) as Promise<{ data: Domain[] }>,
  });
}

function useRegistrationStatus(registrationId: string, enabled = true) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: hostKeys.registrationStatus(registrationId),
    queryFn: () =>
      domains.getRegistrationStatus(registrationId) as Promise<{ data: RegistrationStatusResponse }>,
    enabled: !!registrationId && enabled,
  });
}

// =============================================================================
// DNS zone + record queries — app-api (/api/dns-zones, /api/dns-records)
// =============================================================================

/**
 * Returns the DNS zone for a domain, wrapped in the legacy
 * `{ success, data, records, templates }` shape that the existing consumers
 * still read. The records array is intentionally empty — `useDnsRecords` is
 * the dedicated hook for that.
 */
export function useDnsZones(domainId: string, enabled = true) {
  const { dnsZones } = useAppApi();
  return useQuery({
    queryKey: hostKeys.dnsZones(domainId),
    queryFn: async () => {
      try {
        const res = await dnsZones.byDomain(domainId);
        return { success: true, data: res.data as DnsZone | null, records: [], templates: [] };
      } catch {
        // Zone not yet created (pending verification) — preserve the legacy
        // "empty" shape so the UI shows the verification flow.
        return { success: true, data: null, records: [], templates: [] };
      }
    },
    enabled: !!domainId && enabled,
  });
}

// Re-export schema types under the legacy names so consumers don't churn.
export type HostDnsRecord = DnsRecordSchema;
export type { DnsRecordLock };

export function getDnsRecordLocks(record: HostDnsRecord): DnsRecordLock[] {
  const raw = (record.metadata as Record<string, unknown> | null | undefined)?.locks;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is DnsRecordLock =>
      typeof l === 'object' && l !== null &&
      typeof (l as any).source === 'string' &&
      typeof (l as any).reason === 'string',
  );
}

export function isDnsRecordLocked(record: HostDnsRecord): boolean {
  return getDnsRecordLocks(record).length > 0;
}

function dnsRecordHasSystemLock(record: HostDnsRecord): boolean {
  return getDnsRecordLocks(record).some((l) => l.source !== 'user');
}

export interface DnsRecordsResponse {
  success: boolean;
  data: DnsRecordsListResponse;
}

export function useDnsRecords(domainId: string, enabled = true) {
  const { dnsRecords } = useAppApi();
  return useQuery({
    queryKey: hostKeys.dnsRecords(domainId),
    queryFn: async (): Promise<DnsRecordsResponse> => {
      const res = await dnsRecords.byDomain(domainId);
      return { success: true, data: res.data };
    },
    enabled: !!domainId && enabled,
  });
}

// =============================================================================
// Transfer query — app-api (/api/domain-transfers)
// =============================================================================

function useTransfer(id: string, enabled = true) {
  const { domainTransfers } = useAppApi();
  return useQuery({
    queryKey: hostKeys.transfer(id),
    queryFn: async () => {
      const res = await domainTransfers.get(id);
      // Preserve the legacy `{ success, data }` envelope expected by callers.
      return { success: true, data: res.data };
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Domain mutations — app-api (/api/domains)
// =============================================================================

function useCreateDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDomainInput) => domains.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

function useUpdateDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDomainInput }) =>
      domains.update(id, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(variables.id) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

function useDeleteDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => domains.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

export function useToggleAutoRenew() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, enabled }: { domainId: string; enabled: boolean }) =>
      domains.toggleAutoRenew(domainId, enabled),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
    },
  });
}

function useTogglePrivacyProtection() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, enabled }: { domainId: string; enabled: boolean }) =>
      domains.togglePrivacy(domainId, enabled),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
    },
  });
}

function useToggleTransferLock() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, locked }: { domainId: string; locked: boolean }) =>
      domains.toggleLock(domainId, locked),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
    },
  });
}

function useVerifyNameservers() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.verifyNameservers(domainId),
    onSuccess: (_data, domainId) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
    },
  });
}

function useSyncDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.sync(domainId),
    onSuccess: (_data, domainId) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
    },
  });
}

function useGetTransferAuthCode() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.getAuthCode(domainId),
    onSuccess: (_data, domainId) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(domainId) });
    },
  });
}

function useInitiateDomainCheckout() {
  const { domains } = useAppApi();
  return useMutation({
    mutationFn: (input: CheckoutInput) =>
      domains.checkout(input) as Promise<{ data: CheckoutResponse }>,
  });
}

function useCompleteDomainRegistration() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      registrationId,
      contactInfo,
    }: {
      registrationId: string;
      contactInfo?: Record<string, unknown>;
    }) => domains.completeRegistration(registrationId, { contactInfo }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

interface ExternalDomainReserveResponse {
  data: {
    id: string;
    fullDomain: string;
    verificationRecord: { name: string; type: 'TXT'; value: string };
    [key: string]: any;
  };
}

export function useAddExternalDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExternalDomainInput) =>
      domains.addExternal(input) as Promise<ExternalDomainReserveResponse>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

interface VerifyOwnershipResponse {
  data: {
    id: string;
    fullDomain: string;
    nameservers: string[];
    dnsZone?: { id: string; externalZoneId: string; externalNameservers: string[] } | null;
    [key: string]: any;
  };
}

export function useVerifyDomainOwnership() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) =>
      domains.verifyOwnership(domainId) as unknown as Promise<VerifyOwnershipResponse>,
    onSuccess: (_data, domainId) => {
      qc.invalidateQueries({ queryKey: hostKeys.domain(domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}

// =============================================================================
// DNS / refresh-zone-status / transfer mutations — app-api
// =============================================================================

export interface ScannedDnsRecord extends SchemaScannedDnsRecord {}

export function useScanDnsRecords() {
  const { dnsRecords } = useAppApi();
  return useMutation({
    mutationFn: async (domainId: string) => {
      const res = await dnsRecords.scan(domainId);
      // Preserve legacy `{ success, data: { records } }` envelope.
      return { success: true, data: res.data };
    },
  });
}

interface RefreshZoneStatusResponse {
  data: {
    zoneStatus: 'active' | 'pending' | 'error';
    domainStatus: string;
    cloudflareStatus: string | null;
    nameservers?: string[];
  };
}

export function useRefreshZoneStatus(domainId: string, enabled = true) {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...hostKeys.domain(domainId), 'zone-status'],
    queryFn: async () => {
      const res = (await domains.refreshZoneStatus(domainId)) as unknown as RefreshZoneStatusResponse;
      if (res.data.zoneStatus === 'active') {
        qc.invalidateQueries({ queryKey: hostKeys.domain(domainId) });
        qc.invalidateQueries({ queryKey: hostKeys.dnsZones(domainId) });
      }
      return res;
    },
    enabled: !!domainId && enabled,
    refetchInterval: (query) => {
      const data = query.state.data as RefreshZoneStatusResponse | undefined;
      if (!data) return 20_000;
      return data.data.zoneStatus === 'pending' ? 20_000 : false;
    },
    refetchOnWindowFocus: true,
  });
}

export function useImportDnsRecords() {
  const { dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      domainId,
      records,
    }: {
      domainId: string;
      records: ScannedDnsRecord[];
    }) => {
      const res = await dnsRecords.import(domainId, { records });
      return { success: true, data: res.data };
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(vars.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(vars.domainId) });
    },
  });
}

function useCreateDnsZone() {
  const { dnsZones } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDnsZoneInput) => dnsZones.create(data),
    onSuccess: (_data, variables) => {
      if (variables.domainId) {
        qc.invalidateQueries({ queryKey: hostKeys.dnsZones(variables.domainId) });
      }
    },
  });
}

export interface DnsRecordInput extends SchemaCreateDnsRecordInput {}

interface DnsRecordMutationResponse {
  success: boolean;
  data: DnsRecordsMutationResponse;
}

export function useCreateDnsRecord() {
  const { dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ domainId, data }: { domainId: string; data: DnsRecordInput }) => {
      const res = await dnsRecords.create(domainId, data);
      return { success: true, data: res.data } as DnsRecordMutationResponse;
    },
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(variables.domainId) });
    },
  });
}

export function useUpdateDnsRecord() {
  const { dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      domainId: string;
      data: DnsRecordInput;
    }) => {
      const res = await dnsRecords.update(id, data);
      return { success: true, data: res.data } as DnsRecordMutationResponse;
    },
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(variables.domainId) });
    },
  });
}

export function useDeleteDnsRecord() {
  const { dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; domainId: string }) => {
      const res = await dnsRecords.delete(id);
      return { success: true, data: res.data } as DnsRecordMutationResponse;
    },
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(variables.domainId) });
    },
  });
}

interface SyncDnsRecordsResponseLegacy {
  success: boolean;
  data: SyncDnsRecordsResponse;
}

function useToggleDnsRecordLock() {
  const { dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      locked,
      reason,
    }: {
      id: string;
      domainId: string;
      locked: boolean;
      reason?: string;
    }) => {
      const res = await dnsRecords.toggleLock(id, { locked, reason });
      return { success: true, data: res.data } as DnsRecordMutationResponse;
    },
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(variables.domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(variables.domainId) });
    },
  });
}

function useSyncDnsRecords() {
  const { dnsZones, dnsRecords } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (domainId: string): Promise<SyncDnsRecordsResponseLegacy> => {
      // Resolve domain → zone first so we can hit the zone-scoped sync endpoint.
      const zoneRes = await dnsZones.byDomain(domainId);
      const zoneId = zoneRes.data.id;
      const res = await dnsRecords.syncByZone(zoneId);
      return { success: true, data: res.data };
    },
    onSettled: (_data, _err, domainId) => {
      qc.invalidateQueries({ queryKey: hostKeys.dnsRecords(domainId) });
      qc.invalidateQueries({ queryKey: hostKeys.dnsZones(domainId) });
    },
  });
}

// =============================================================================
// Transfer mutation — app-api (/api/domain-transfers)
// =============================================================================

function useCreateTransfer() {
  const { domainTransfers } = useAppApi();
  return useMutation({
    mutationFn: async (data: {
      domainName: string;
      type: 'incoming' | 'outgoing';
      domainId?: string;
      authCode?: string;
      fromRegistrar?: string;
      toRegistrar?: string;
    }) => {
      const res = await domainTransfers.create(data);
      return { success: true, data: res.data };
    },
  });
}
