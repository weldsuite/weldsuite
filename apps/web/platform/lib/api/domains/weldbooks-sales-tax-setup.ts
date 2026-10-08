/**
 * WeldBooks US sales tax setup client: agencies (registrations), the manual
 * engine's jurisdictions with dated rates, tax zones and taxability rules, the
 * engine settings (manual, Stripe Tax, Avalara with the customer's own
 * credentials, the registration check, address validation) and exemption
 * certificates. Talks to books-api through the same `weldbooksApi` transport
 * as `accountingApi`; shapes mirror
 * `apps/workers/books-api/src/routes/{sales-tax-agencies,sales-tax-jurisdictions,
 * sales-tax-zones,sales-tax-rules,exemption-certificates,sales-tax/settings}`.
 *
 * Rates and percentages are numbers from 0 to 100 on the way in; the tables
 * return them as numeric strings ("6.2500"). Dates are `YYYY-MM-DD`.
 */
import { weldbooksApi } from '../weldbooks-client';

// ============================================================================
// Envelopes and helpers
// ============================================================================

interface Envelope<T> {
  data: T;
}

export interface SetupPage<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** What a failed call carries: the status, the error code and the server's sentence. */
export interface SalesTaxSetupRequestError extends Error {
  status: number;
  code: string | null;
}

export function isSalesTaxSetupRequestError(err: unknown): err is SalesTaxSetupRequestError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

/** The ceiling every list call asks for: an entity has at most a few dozen agencies, zones or rules. */
const ALL = 200;

// ============================================================================
// Vocabulary
// ============================================================================

export const AGENCY_STATUSES = ['registered', 'pending', 'monitoring', 'closed'] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];

export const AGENCY_LEVELS = ['state', 'local'] as const;
export type AgencyLevel = (typeof AGENCY_LEVELS)[number];

export const FILING_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];

export const REPORTING_BASES = ['accrual', 'cash'] as const;
export type ReportingBasis = (typeof REPORTING_BASES)[number];

export const JURISDICTION_LEVELS = ['state', 'county', 'city', 'district'] as const;
export type JurisdictionLevel = (typeof JURISDICTION_LEVELS)[number];

export const TAX_USES = ['any', 'business', 'personal'] as const;
export type RuleUse = (typeof TAX_USES)[number];

export const SALES_TAX_ENGINES = ['manual', 'stripe_tax', 'avalara'] as const;
export type SalesTaxEngineId = (typeof SALES_TAX_ENGINES)[number];

export const CERTIFICATE_REASONS = ['resale', 'nonprofit', 'government', 'manufacturing', 'agricultural', 'other'] as const;
export type CertificateReason = (typeof CERTIFICATE_REASONS)[number];

export const CERTIFICATE_FORMS = ['sst_f0003', 'mtc_uniform', 'state_form', 'other'] as const;
export type CertificateForm = (typeof CERTIFICATE_FORMS)[number];

export const CERTIFICATE_STATUSES = ['valid', 'expired', 'pending', 'revoked'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

// ============================================================================
// Agencies
// ============================================================================

/** The payable account an agency's liability is booked to. */
export interface AgencyAccount {
  id: string;
  code: string;
  name: string;
  /** Numeric string, credit-normal: what is owed. */
  balance: string | null;
}

export interface SalesTaxAgency {
  id: string;
  entityId: string;
  stateCode: string;
  level: AgencyLevel;
  localJurisdictionCode: string | null;
  name: string;
  registrationNumber: string | null;
  registeredFrom: string | null;
  registeredUntil: string | null;
  status: AgencyStatus;
  filingFrequency: FilingFrequency;
  firstPeriodStart: string | null;
  /** Day of the month after the period the return is due; 31 stands for the last day. */
  dueDay: number;
  reportingBasis: ReportingBasis;
  sstMember: boolean;
  liabilityAccountId: string | null;
  useTaxAccountId: string | null;
  portalUrl: string | null;
  providerRegistrationRef: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  liabilityAccount: AgencyAccount | null;
  useTaxAccount: AgencyAccount | null;
}

export interface SalesTaxAgencyDetail extends SalesTaxAgency {
  /** A registration that has been used can only be closed, never deleted. */
  hasTaxLines: boolean;
}

export interface CreateAgencyInput {
  stateCode: string;
  level?: AgencyLevel;
  localJurisdictionCode?: string | null;
  name?: string;
  registrationNumber?: string | null;
  registeredFrom?: string | null;
  registeredUntil?: string | null;
  status?: AgencyStatus;
  filingFrequency?: FilingFrequency;
  firstPeriodStart?: string | null;
  dueDay?: number;
  reportingBasis?: ReportingBasis;
  sstMember?: boolean;
  portalUrl?: string | null;
  notes?: string | null;
}

/** The state and level of an agency never change; everything else can. */
export type UpdateAgencyInput = Partial<Omit<CreateAgencyInput, 'stateCode' | 'level' | 'localJurisdictionCode'>>;

export interface CreatedAgency extends SalesTaxAgency {
  accountsCreated: number;
  rulesSeeded: number;
}

export type DeleteAgencyResult =
  | { deleted: true }
  | { deleted: false; closed: true; status: 'closed'; registeredUntil: string | null };

export interface AgencyFilter {
  status?: AgencyStatus;
  stateCode?: string;
  level?: AgencyLevel;
}

// ============================================================================
// Jurisdictions and rates
// ============================================================================

export interface JurisdictionRate {
  id: string;
  jurisdictionId: string;
  /** Percent as a numeric string, up to four decimals ("6.2500"). */
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface SalesTaxJurisdiction {
  id: string;
  agencyId: string;
  stateCode: string;
  level: JurisdictionLevel;
  code: string | null;
  name: string;
  reportingCode: string | null;
  isActive: boolean;
  /** The rate in force today, as a number; null when none is. */
  currentRate: number | null;
  /** Newest first. */
  rates: JurisdictionRate[];
}

export interface RateInput {
  /** Percent, 0 to 100. */
  rate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface CreateJurisdictionInput {
  agencyId: string;
  level: JurisdictionLevel;
  name: string;
  code?: string | null;
  reportingCode?: string | null;
  isActive?: boolean;
  /** The first rate. */
  rate?: RateInput;
}

export type UpdateJurisdictionInput = Partial<Pick<CreateJurisdictionInput, 'level' | 'name' | 'code' | 'reportingCode' | 'isActive'>>;

export interface CreateRateInput extends RateInput {
  /** End the open-ended rate in force before this one the day before it starts. */
  closePrevious?: boolean;
}

export type UpdateRateInput = Partial<RateInput>;

// ============================================================================
// Zones
// ============================================================================

export type ZipEntry = string | { from: string; to: string };

export interface ZoneJurisdiction {
  id: string;
  name: string;
  level: JurisdictionLevel;
  currentRate: number | null;
}

export interface SalesTaxZone {
  id: string;
  agencyId: string;
  stateCode: string;
  name: string;
  jurisdictionIds: string[];
  postalCodes: ZipEntry[] | null;
  isOrigin: boolean;
  /** Lower wins when two zones cover the same ZIP. */
  priority: number;
  jurisdictions: ZoneJurisdiction[];
  /** The sum of the jurisdictions' current rates, in percent. */
  combinedRate: number;
}

export interface CreateZoneInput {
  agencyId: string;
  name: string;
  jurisdictionIds: string[];
  postalCodes?: ZipEntry[];
  isOrigin?: boolean;
  priority?: number;
}

export type UpdateZoneInput = Partial<Omit<CreateZoneInput, 'agencyId'>>;

// ============================================================================
// Taxability rules
// ============================================================================

export interface SalesTaxRule {
  id: string;
  agencyId: string;
  taxCode: string;
  taxable: boolean;
  /** Numeric string, 0 to 100. */
  taxablePercent: string;
  appliesToUse: RuleUse;
  rateOverride: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
}

export interface CreateRuleInput {
  agencyId: string;
  taxCode: string;
  taxable: boolean;
  taxablePercent?: number;
  appliesToUse?: RuleUse;
  rateOverride?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export type UpdateRuleInput = Partial<Omit<CreateRuleInput, 'agencyId'>>;

// ============================================================================
// Engine settings
// ============================================================================

export interface SalesTaxEngineOption {
  id: SalesTaxEngineId;
  credentialFields: ReadonlyArray<'apiKey' | 'accountId' | 'licenseKey'>;
  configFields: ReadonlyArray<'companyCode' | 'environment'>;
}

export interface SettingsAgency {
  id: string;
  stateCode: string;
  level: AgencyLevel;
  name: string;
  status: AgencyStatus;
  registeredFrom: string | null;
  registeredUntil: string | null;
  providerRegistrationRef: string | null;
}

export type AvalaraEnvironment = 'sandbox' | 'production';

export interface SalesTaxSettings {
  entityId: string;
  engine: SalesTaxEngineId;
  config: { companyCode: string | null; environment: AvalaraEnvironment };
  /** The stored credentials are never returned, only whether some are stored. */
  hasCredentials: boolean;
  engineOptions: SalesTaxEngineOption[];
  agencies: SettingsAgency[];
  registeredStates: string[];
}

/** Stripe Tax takes `{ apiKey }`, Avalara `{ accountId, licenseKey }`; null removes the stored ones. */
export type EngineCredentials = { apiKey: string } | { accountId: string; licenseKey: string };

export interface UpdateSettingsInput {
  engine: SalesTaxEngineId;
  config?: { companyCode?: string; environment?: AvalaraEnvironment };
  credentials?: EngineCredentials | null;
}

export interface RegistrationCheck {
  engine: string;
  matched: Array<{ agencyId: string; stateCode: string; name: string; providerRef: string | null }>;
  /** Registered here, unknown to the provider: it won't calculate tax for that state. */
  missingInProvider: Array<{ agencyId: string; stateCode: string; name: string }>;
  /** Registered at the provider, not here: tax would be calculated that WeldBooks doesn't charge. */
  missingInWeldBooks: Array<{ stateCode: string; providerRef: string }>;
  inSync: boolean;
}

export interface ValidateAddressInput {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface AddressValidationResult {
  engine: string;
  valid: boolean;
  normalized?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  };
  messages?: string[];
}

// ============================================================================
// Exemption certificates
// ============================================================================

export interface ExemptionCertificate {
  id: string;
  entityId: string;
  partyId: string;
  states: string[];
  reason: CertificateReason;
  certificateNumber: string | null;
  form: CertificateForm;
  issuedOn: string | null;
  expiresOn: string | null;
  blanket: boolean;
  invoiceId: string | null;
  documentId: string | null;
  /** Computed for today: a valid certificate lapses when every state it covers has lapsed. */
  status: CertificateStatus;
  storedStatus: CertificateStatus;
  /** The last valid day per state; null where the certificate doesn't expire. */
  expiryByState: Record<string, string | null>;
  expiredStates: string[];
  /** The last day it is valid anywhere; null when it doesn't expire in some state. */
  effectiveExpiresOn: string | null;
  daysUntilExpiry: number | null;
  lastUsedOn: string | null;
  receivedOn: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateFilter {
  partyId?: string;
  status?: CertificateStatus;
  expiringWithinDays?: number;
}

export interface CreateCertificateInput {
  partyId: string;
  states: string[];
  reason: CertificateReason;
  certificateNumber?: string | null;
  form?: CertificateForm;
  issuedOn?: string | null;
  expiresOn?: string | null;
  blanket?: boolean;
  invoiceId?: string | null;
  documentId?: string | null;
  status?: CertificateStatus;
  receivedOn?: string | null;
  notes?: string | null;
}

export type UpdateCertificateInput = Partial<Omit<CreateCertificateInput, 'partyId'>>;

// ============================================================================
// Client
// ============================================================================

export const salesTaxSetupApi = {
  // ---- agencies ----
  async listAgencies(filter: AgencyFilter = {}): Promise<SalesTaxAgency[]> {
    const res = await weldbooksApi.get<SetupPage<SalesTaxAgency>>(
      `/sales-tax-agencies${buildQuery({ ...filter, pageSize: ALL })}`,
    );
    return res.data ?? [];
  },
  async getAgency(id: string): Promise<SalesTaxAgencyDetail> {
    const res = await weldbooksApi.get<Envelope<SalesTaxAgencyDetail>>(`/sales-tax-agencies/${id}`);
    return res.data;
  },
  async createAgency(input: CreateAgencyInput): Promise<CreatedAgency> {
    const res = await weldbooksApi.post<Envelope<CreatedAgency>>('/sales-tax-agencies', input);
    return res.data;
  },
  async updateAgency(id: string, input: UpdateAgencyInput): Promise<SalesTaxAgency> {
    const res = await weldbooksApi.patch<Envelope<SalesTaxAgency>>(`/sales-tax-agencies/${id}`, input);
    return res.data;
  },
  /** 204 when nothing was ever taxed under it; otherwise the agency is closed and the body says so. */
  async deleteAgency(id: string): Promise<DeleteAgencyResult> {
    const res = await weldbooksApi.delete<Envelope<{ closed?: boolean; status?: 'closed'; registeredUntil?: string | null }> | undefined>(
      `/sales-tax-agencies/${id}`,
    );
    const body = res?.data;
    if (body?.closed) return { deleted: false, closed: true, status: 'closed', registeredUntil: body.registeredUntil ?? null };
    return { deleted: true };
  },

  // ---- jurisdictions and rates ----
  async listJurisdictions(filter: { agencyId?: string; stateCode?: string; level?: JurisdictionLevel } = {}): Promise<SalesTaxJurisdiction[]> {
    const res = await weldbooksApi.get<SetupPage<SalesTaxJurisdiction>>(
      `/sales-tax-jurisdictions${buildQuery({ ...filter, pageSize: ALL })}`,
    );
    return res.data ?? [];
  },
  async createJurisdiction(input: CreateJurisdictionInput): Promise<SalesTaxJurisdiction> {
    const res = await weldbooksApi.post<Envelope<SalesTaxJurisdiction>>('/sales-tax-jurisdictions', input);
    return res.data;
  },
  async updateJurisdiction(id: string, input: UpdateJurisdictionInput): Promise<SalesTaxJurisdiction> {
    const res = await weldbooksApi.patch<Envelope<SalesTaxJurisdiction>>(`/sales-tax-jurisdictions/${id}`, input);
    return res.data;
  },
  async deleteJurisdiction(id: string): Promise<void> {
    await weldbooksApi.delete<void>(`/sales-tax-jurisdictions/${id}`);
  },
  async createRate(jurisdictionId: string, input: CreateRateInput): Promise<JurisdictionRate> {
    const res = await weldbooksApi.post<Envelope<JurisdictionRate>>(`/sales-tax-jurisdictions/${jurisdictionId}/rates`, input);
    return res.data;
  },
  async updateRate(jurisdictionId: string, rateId: string, input: UpdateRateInput): Promise<JurisdictionRate> {
    const res = await weldbooksApi.patch<Envelope<JurisdictionRate>>(
      `/sales-tax-jurisdictions/${jurisdictionId}/rates/${rateId}`,
      input,
    );
    return res.data;
  },
  async deleteRate(jurisdictionId: string, rateId: string): Promise<void> {
    await weldbooksApi.delete<void>(`/sales-tax-jurisdictions/${jurisdictionId}/rates/${rateId}`);
  },

  // ---- zones ----
  async listZones(filter: { agencyId?: string; stateCode?: string } = {}): Promise<SalesTaxZone[]> {
    const res = await weldbooksApi.get<SetupPage<SalesTaxZone>>(`/sales-tax-zones${buildQuery({ ...filter, pageSize: ALL })}`);
    return res.data ?? [];
  },
  async createZone(input: CreateZoneInput): Promise<SalesTaxZone> {
    const res = await weldbooksApi.post<Envelope<SalesTaxZone>>('/sales-tax-zones', input);
    return res.data;
  },
  async updateZone(id: string, input: UpdateZoneInput): Promise<SalesTaxZone> {
    const res = await weldbooksApi.patch<Envelope<SalesTaxZone>>(`/sales-tax-zones/${id}`, input);
    return res.data;
  },
  async deleteZone(id: string): Promise<void> {
    await weldbooksApi.delete<void>(`/sales-tax-zones/${id}`);
  },

  // ---- taxability rules ----
  async listRules(filter: { agencyId?: string; taxCode?: string } = {}): Promise<SalesTaxRule[]> {
    const res = await weldbooksApi.get<SetupPage<SalesTaxRule>>(`/sales-tax-rules${buildQuery({ ...filter, pageSize: ALL })}`);
    return res.data ?? [];
  },
  async createRule(input: CreateRuleInput): Promise<SalesTaxRule> {
    const res = await weldbooksApi.post<Envelope<SalesTaxRule>>('/sales-tax-rules', input);
    return res.data;
  },
  async updateRule(id: string, input: UpdateRuleInput): Promise<SalesTaxRule> {
    const res = await weldbooksApi.patch<Envelope<SalesTaxRule>>(`/sales-tax-rules/${id}`, input);
    return res.data;
  },
  async deleteRule(id: string): Promise<void> {
    await weldbooksApi.delete<void>(`/sales-tax-rules/${id}`);
  },

  // ---- engine settings ----
  async getSettings(): Promise<SalesTaxSettings> {
    const res = await weldbooksApi.get<Envelope<SalesTaxSettings>>('/sales-tax/settings');
    return res.data;
  },
  async updateSettings(input: UpdateSettingsInput): Promise<SalesTaxSettings> {
    const res = await weldbooksApi.put<Envelope<SalesTaxSettings>>('/sales-tax/settings', input);
    return res.data;
  },
  async checkRegistrations(): Promise<RegistrationCheck> {
    const res = await weldbooksApi.post<Envelope<RegistrationCheck>>('/sales-tax/registration-check');
    return res.data;
  },
  async validateAddress(address: ValidateAddressInput): Promise<AddressValidationResult> {
    const res = await weldbooksApi.post<Envelope<AddressValidationResult>>('/sales-tax/validate-address', { address });
    return res.data;
  },

  // ---- exemption certificates ----
  async listCertificates(filter: CertificateFilter = {}): Promise<ExemptionCertificate[]> {
    const res = await weldbooksApi.get<SetupPage<ExemptionCertificate>>(
      `/exemption-certificates${buildQuery({ ...filter, pageSize: ALL })}`,
    );
    return res.data ?? [];
  },
  async getCertificate(id: string): Promise<ExemptionCertificate> {
    const res = await weldbooksApi.get<Envelope<ExemptionCertificate>>(`/exemption-certificates/${id}`);
    return res.data;
  },
  async createCertificate(input: CreateCertificateInput): Promise<ExemptionCertificate> {
    const res = await weldbooksApi.post<Envelope<ExemptionCertificate>>('/exemption-certificates', input);
    return res.data;
  },
  async updateCertificate(id: string, input: UpdateCertificateInput): Promise<ExemptionCertificate> {
    const res = await weldbooksApi.patch<Envelope<ExemptionCertificate>>(`/exemption-certificates/${id}`, input);
    return res.data;
  },
  async deleteCertificate(id: string): Promise<void> {
    await weldbooksApi.delete<void>(`/exemption-certificates/${id}`);
  },
};
