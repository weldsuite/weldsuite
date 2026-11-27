/**
 * App-API mail-domains domain client — flat `/api/mail-domains/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailDomainInput,
  UpdateMailDomainInput,
  ListMailDomainsQuery,
  DmarcPolicy,
  DmarcRecordCheck,
  DmarcPeriodDays,
  MarkDmarcSourceInput,
} from '../schemas/mail-domains';

export interface MailDnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  ttl?: number;
  verified?: boolean;
  purpose?: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'verification' | 'other';
  /** On the DMARC entry: the state of the record the domain publishes now. */
  dmarc?: DmarcRecordCheck;
}

export type DmarcBlocker =
  | { code: 'recordProblem'; state: string }
  | { code: 'noReports' }
  | { code: 'tooFewDays'; have: number; need: number }
  | { code: 'tooFewReporters'; have: number; need: number }
  | { code: 'passRate'; permille: number; need: number }
  | { code: 'weldsuiteFailing'; permille: number; need: number }
  | { code: 'failingSource'; key: string; name: string; sharePermille: number; passPermille: number }
  | { code: 'tooSoon'; days: number; need: number };

export type DmarcSourceMark = 'mine' | 'not_mine';

export interface DmarcSource {
  key: string;
  kind: 'weldsuite' | 'name' | 'ip';
  name: string;
  ips: string[];
  messages: number;
  passed: number;
  dkimAligned: number;
  spfAligned: number;
  mark: DmarcSourceMark | null;
}

export interface DmarcSummary {
  domainId: string;
  domainName: string;
  reportAddress: string | null;
  record: {
    state: 'missing' | 'multiple' | 'invalid' | 'ok' | 'unchecked';
    found: string[];
    policy: DmarcPolicy | null;
    reportsToWeldSuite: boolean;
    suggested: string | null;
  };
  period: { days: number; from: string; to: string };
  totals: {
    messages: number;
    passed: number;
    dkimAligned: number;
    spfAligned: number;
    reports: number;
    authenticatedReports: number;
    lastReportAt: string | null;
  };
  sources: DmarcSource[];
  reporters: Array<{ domain: string; org: string; reports: number; messages: number }>;
  failures: Array<{
    sourceKey: string;
    sourceName: string;
    headerFrom: string;
    dkimAligned: boolean;
    spfAligned: boolean;
    dkimDomains: string[];
    spfDomain: string | null;
    messages: number;
  }>;
  advice: {
    current: string | null;
    next: 'quarantine' | 'reject' | null;
    ready: boolean;
    suggestedRecord: string | null;
    blockers: DmarcBlocker[];
  };
}

export interface DmarcReport {
  id: string;
  reporterOrg: string;
  reporterEmail: string;
  reporterDomain: string;
  reportId: string;
  periodStart: string;
  periodEnd: string;
  policyDomain: string;
  policy: Record<string, unknown> | null;
  authenticated: boolean;
  messages: number;
  passed: number;
  receivedAt: string;
}

export interface MailDomainRow {
  id: string;
  domainName: string;
  isActive: boolean;
  isPrimary: boolean | null;
  mailProvider: string | null;
  sendProvider: string | null;
  receiveProvider: string | null;
  maxEmailAccounts: number | null;
  currentEmailAccounts: number | null;
  dnsStatus: string | null;
  dnsRecords: MailDnsRecord[] | null;
  verifiedAt: string | null;
  lastVerificationAttempt: string | null;
  spfVerified: boolean | null;
  dkimVerified: boolean | null;
  dmarcVerified: boolean | null;
  dkimSelector: string | null;
  dkimPublicKey: string | null;
  cloudflareZoneId: string | null;
  cloudflareRoutingEnabled: boolean | null;
  cloudflareRoutingRuleId: string | null;
  /** Opt-in app-level catch-all for unmatched addresses on this domain. */
  catchAllEnabled: boolean;
  catchAllAccountId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailDomainDkimRecord {
  selector: string;
  dnsRecord: string;
  /** `cloudflare` on Global; `mta` or `manual` on the Kubernetes editions. */
  provider: string;
}

export function createMailDomainsApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailDomainsQuery> = {}): Promise<DataResponse<MailDomainRow[]>> {
      return api.get<DataResponse<MailDomainRow[]>>(
        `/mail-domains${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailDomainRow>> {
      return api.get<DataResponse<MailDomainRow>>(`/mail-domains/${id}`);
    },

    byName(domainName: string): Promise<DataResponse<MailDomainRow>> {
      return api.get<DataResponse<MailDomainRow>>(
        `/mail-domains/by-name/${encodeURIComponent(domainName)}`,
      );
    },

    create(data: CreateMailDomainInput): Promise<DataResponse<MailDomainRow>> {
      return api.post<DataResponse<MailDomainRow>>('/mail-domains', data);
    },

    update(id: string, data: UpdateMailDomainInput): Promise<DataResponse<MailDomainRow>> {
      return api.patch<DataResponse<MailDomainRow>>(`/mail-domains/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-domains/${id}`);
    },

    verify(id: string): Promise<DataResponse<MailDomainRow>> {
      return api.post<DataResponse<MailDomainRow>>(`/mail-domains/${id}/verify`, {});
    },

    sync(id: string): Promise<DataResponse<MailDomainRow>> {
      return api.post<DataResponse<MailDomainRow>>(`/mail-domains/${id}/sync`, {});
    },

    dmarcSummary(id: string, days: DmarcPeriodDays = 30): Promise<DataResponse<DmarcSummary>> {
      return api.get<DataResponse<DmarcSummary>>(`/mail-domains/${id}/dmarc?days=${days}`);
    },

    dmarcReports(
      id: string,
      params: { limit?: number; cursor?: string } = {},
    ): Promise<ListResponse<DmarcReport>> {
      return api.get<ListResponse<DmarcReport>>(
        `/mail-domains/${id}/dmarc/reports${buildQueryString(params)}`,
      );
    },

    /** The key goes in the body: it contains ':' and '.'. */
    markDmarcSource(
      id: string,
      data: MarkDmarcSourceInput,
    ): Promise<DataResponse<{ key: string; mark: DmarcSourceMark | null }>> {
      return api.patch<DataResponse<{ key: string; mark: DmarcSourceMark | null }>>(
        `/mail-domains/${id}/dmarc/sources`,
        data,
      );
    },

    generateDkim(id: string): Promise<DataResponse<MailDomainDkimRecord>> {
      return api.post<DataResponse<MailDomainDkimRecord>>(
        `/mail-domains/${id}/generate-dkim`,
        {},
      );
    },
  };
}
