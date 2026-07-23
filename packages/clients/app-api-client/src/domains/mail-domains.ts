/**
 * App-API mail-domains domain client — flat `/api/mail-domains/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailDomainInput,
  UpdateMailDomainInput,
  ListMailDomainsQuery,
} from '../schemas/mail-domains';

export interface MailDnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  ttl?: number;
  verified?: boolean;
  purpose?: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'verification' | 'other';
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
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailDomainDkimRecord {
  selector: string;
  dnsRecord: string;
  provider: 'cloudflare';
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

    generateDkim(id: string): Promise<DataResponse<MailDomainDkimRecord>> {
      return api.post<DataResponse<MailDomainDkimRecord>>(
        `/mail-domains/${id}/generate-dkim`,
        {},
      );
    },
  };
}
