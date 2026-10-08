/**
 * WeldBooks US sales tax setup queries and mutations: agencies, jurisdictions
 * and rates, zones, taxability rules, the engine settings and exemption
 * certificates.
 *
 * Keys live under `['accounting', 'sales-tax-setup', ...]`, so the entity
 * switch resets them with the other entity-scoped accounting data
 * (`isEntityScopedAccountingQuery`): all of it belongs to one entity.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  salesTaxSetupApi,
  type AgencyFilter,
  type CertificateFilter,
  type CreateAgencyInput,
  type CreateCertificateInput,
  type CreateJurisdictionInput,
  type CreateRateInput,
  type CreateRuleInput,
  type CreateZoneInput,
  type UpdateAgencyInput,
  type UpdateCertificateInput,
  type UpdateJurisdictionInput,
  type UpdateRateInput,
  type UpdateRuleInput,
  type UpdateSettingsInput,
  type UpdateZoneInput,
  type ValidateAddressInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { accountingKeys } from './use-accounting-queries';

export const salesTaxSetupKeys = {
  all: ['accounting', 'sales-tax-setup'] as const,
  agencies: {
    all: [...(['accounting', 'sales-tax-setup', 'agencies'] as const)],
    list: (filter?: AgencyFilter) => [...salesTaxSetupKeys.agencies.all, 'list', filter ?? {}] as const,
    detail: (id: string) => [...salesTaxSetupKeys.agencies.all, 'detail', id] as const,
  },
  jurisdictions: {
    all: [...(['accounting', 'sales-tax-setup', 'jurisdictions'] as const)],
    list: (agencyId: string) => [...salesTaxSetupKeys.jurisdictions.all, 'list', agencyId] as const,
  },
  zones: {
    all: [...(['accounting', 'sales-tax-setup', 'zones'] as const)],
    list: (agencyId: string) => [...salesTaxSetupKeys.zones.all, 'list', agencyId] as const,
  },
  rules: {
    all: [...(['accounting', 'sales-tax-setup', 'rules'] as const)],
    list: (agencyId: string) => [...salesTaxSetupKeys.rules.all, 'list', agencyId] as const,
  },
  settings: () => [...salesTaxSetupKeys.all, 'settings'] as const,
  certificates: {
    all: [...(['accounting', 'sales-tax-setup', 'certificates'] as const)],
    list: (filter?: CertificateFilter) => [...salesTaxSetupKeys.certificates.all, 'list', filter ?? {}] as const,
    detail: (id: string) => [...salesTaxSetupKeys.certificates.all, 'detail', id] as const,
  },
  customerInvoices: (partyId: string) => [...salesTaxSetupKeys.all, 'customer-invoices', partyId] as const,
  document: (id: string) => [...salesTaxSetupKeys.all, 'document', id] as const,
};

/** The Sales Tax Center's own queries (due dates, returns, nexus) read agencies and certificates too. */
const SALES_TAX_CENTER_KEY = ['accounting', 'sales-tax-center'] as const;

function invalidateCenter(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: SALES_TAX_CENTER_KEY });
}

// ============================================================================
// Agencies
// ============================================================================

export function useSalesTaxAgencies(filter?: AgencyFilter, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxSetupKeys.agencies.list(filter),
    queryFn: () => salesTaxSetupApi.listAgencies(filter),
    enabled: options.enabled ?? true,
  });
}

export function useSalesTaxAgency(id: string) {
  return useQuery({
    queryKey: salesTaxSetupKeys.agencies.detail(id),
    queryFn: () => salesTaxSetupApi.getAgency(id),
    enabled: !!id,
  });
}

export function useCreateSalesTaxAgency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgencyInput) => salesTaxSetupApi.createAgency(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.agencies.all });
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.rules.all });
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.settings() });
      // Registering adds the agency's payable accounts to the chart.
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      invalidateCenter(qc);
    },
  });
}

export function useUpdateSalesTaxAgency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAgencyInput }) => salesTaxSetupApi.updateAgency(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.agencies.all });
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.settings() });
      invalidateCenter(qc);
    },
  });
}

export function useDeleteSalesTaxAgency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxSetupApi.deleteAgency(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.all });
      invalidateCenter(qc);
    },
  });
}

// ============================================================================
// Jurisdictions and rates
// ============================================================================

export function useSalesTaxJurisdictions(agencyId: string) {
  return useQuery({
    queryKey: salesTaxSetupKeys.jurisdictions.list(agencyId),
    queryFn: () => salesTaxSetupApi.listJurisdictions({ agencyId }),
    enabled: !!agencyId,
  });
}

/** A rate change moves the combined rate of every zone that uses the jurisdiction. */
function invalidateRates(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: salesTaxSetupKeys.jurisdictions.all });
  qc.invalidateQueries({ queryKey: salesTaxSetupKeys.zones.all });
}

export function useCreateSalesTaxJurisdiction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJurisdictionInput) => salesTaxSetupApi.createJurisdiction(input),
    onSuccess: () => invalidateRates(qc),
  });
}

export function useUpdateSalesTaxJurisdiction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateJurisdictionInput }) =>
      salesTaxSetupApi.updateJurisdiction(id, input),
    onSuccess: () => invalidateRates(qc),
  });
}

export function useDeleteSalesTaxJurisdiction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxSetupApi.deleteJurisdiction(id),
    onSuccess: () => invalidateRates(qc),
  });
}

export function useCreateSalesTaxRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jurisdictionId, input }: { jurisdictionId: string; input: CreateRateInput }) =>
      salesTaxSetupApi.createRate(jurisdictionId, input),
    onSuccess: () => invalidateRates(qc),
  });
}

export function useUpdateSalesTaxRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jurisdictionId, rateId, input }: { jurisdictionId: string; rateId: string; input: UpdateRateInput }) =>
      salesTaxSetupApi.updateRate(jurisdictionId, rateId, input),
    onSuccess: () => invalidateRates(qc),
  });
}

export function useDeleteSalesTaxRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jurisdictionId, rateId }: { jurisdictionId: string; rateId: string }) =>
      salesTaxSetupApi.deleteRate(jurisdictionId, rateId),
    onSuccess: () => invalidateRates(qc),
  });
}

// ============================================================================
// Zones
// ============================================================================

export function useSalesTaxZones(agencyId: string) {
  return useQuery({
    queryKey: salesTaxSetupKeys.zones.list(agencyId),
    queryFn: () => salesTaxSetupApi.listZones({ agencyId }),
    enabled: !!agencyId,
  });
}

export function useCreateSalesTaxZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateZoneInput) => salesTaxSetupApi.createZone(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.zones.all }),
  });
}

export function useUpdateSalesTaxZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateZoneInput }) => salesTaxSetupApi.updateZone(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.zones.all }),
  });
}

export function useDeleteSalesTaxZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxSetupApi.deleteZone(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.zones.all }),
  });
}

// ============================================================================
// Taxability rules
// ============================================================================

export function useSalesTaxRules(agencyId: string) {
  return useQuery({
    queryKey: salesTaxSetupKeys.rules.list(agencyId),
    queryFn: () => salesTaxSetupApi.listRules({ agencyId }),
    enabled: !!agencyId,
  });
}

export function useCreateSalesTaxRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuleInput) => salesTaxSetupApi.createRule(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.rules.all }),
  });
}

export function useUpdateSalesTaxRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRuleInput }) => salesTaxSetupApi.updateRule(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.rules.all }),
  });
}

export function useDeleteSalesTaxRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxSetupApi.deleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: salesTaxSetupKeys.rules.all }),
  });
}

// ============================================================================
// Engine settings
// ============================================================================

export function useSalesTaxSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxSetupKeys.settings(),
    queryFn: () => salesTaxSetupApi.getSettings(),
    enabled: options.enabled ?? true,
  });
}

export function useUpdateSalesTaxSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => salesTaxSetupApi.updateSettings(input),
    onSuccess: (settings) => {
      qc.setQueryData(salesTaxSetupKeys.settings(), settings);
      invalidateCenter(qc);
    },
  });
}

export function useCheckSalesTaxRegistrations() {
  return useMutation({ mutationFn: () => salesTaxSetupApi.checkRegistrations() });
}

export function useValidateSalesTaxAddress() {
  return useMutation({ mutationFn: (address: ValidateAddressInput) => salesTaxSetupApi.validateAddress(address) });
}

// ============================================================================
// Exemption certificates
// ============================================================================

export function useExemptionCertificates(filter?: CertificateFilter, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxSetupKeys.certificates.list(filter),
    queryFn: () => salesTaxSetupApi.listCertificates(filter),
    enabled: options.enabled ?? true,
  });
}

export function useExemptionCertificate(id: string) {
  return useQuery({
    queryKey: salesTaxSetupKeys.certificates.detail(id),
    queryFn: () => salesTaxSetupApi.getCertificate(id),
    enabled: !!id,
  });
}

export function useCreateExemptionCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCertificateInput) => salesTaxSetupApi.createCertificate(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.certificates.all });
      invalidateCenter(qc);
    },
  });
}

export function useUpdateExemptionCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCertificateInput }) => salesTaxSetupApi.updateCertificate(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.certificates.all });
      invalidateCenter(qc);
    },
  });
}

export function useDeleteExemptionCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxSetupApi.deleteCertificate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxSetupKeys.certificates.all });
      invalidateCenter(qc);
    },
  });
}

/** The invoices of one customer, newest first, for the invoice a single-purchase certificate covers. */
export function useCustomerInvoices(partyId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxSetupKeys.customerInvoices(partyId ?? ''),
    queryFn: async () => (await accountingApi.listInvoices({ contactId: partyId ?? undefined, pageSize: 100 })).data ?? [],
    enabled: (options.enabled ?? true) && !!partyId,
  });
}

/** The accounting document behind a scanned certificate (its file name). */
export function useAccountingDocument(id: string | null | undefined) {
  return useQuery({
    queryKey: salesTaxSetupKeys.document(id ?? ''),
    queryFn: async () => (await accountingApi.getDocument(id ?? '')).data,
    enabled: !!id,
  });
}
