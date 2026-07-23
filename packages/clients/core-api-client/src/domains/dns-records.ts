/**
 * DNS records API factory (app-api).
 *
 * Every mutation goes through Cloudflare and the server re-syncs the local
 * table immediately, so the response always carries the freshly-reconciled
 * record list.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  CreateDnsRecordInput,
  UpdateDnsRecordInput,
  ToggleDnsRecordLockInput,
  ImportDnsRecordsInput,
  DnsRecordsListResponse,
  DnsRecordsMutationResponse,
  SyncDnsRecordsResponse,
  ScanDnsRecordsResponse,
  ImportDnsRecordsResponse,
} from '../schemas/dns-records';

export function createDnsRecordsApi(api: ClientApi) {
  return {
    byZone(zoneId: string): Promise<DataResponse<DnsRecordsListResponse>> {
      return api.get<DataResponse<DnsRecordsListResponse>>(`/dns-records/by-zone/${zoneId}`);
    },
    byDomain(domainId: string): Promise<DataResponse<DnsRecordsListResponse>> {
      return api.get<DataResponse<DnsRecordsListResponse>>(`/dns-records/by-domain/${domainId}`);
    },
    syncByZone(zoneId: string): Promise<DataResponse<SyncDnsRecordsResponse>> {
      return api.post<DataResponse<SyncDnsRecordsResponse>>(`/dns-records/by-zone/${zoneId}/sync`);
    },
    scan(domainId: string): Promise<DataResponse<ScanDnsRecordsResponse>> {
      return api.post<DataResponse<ScanDnsRecordsResponse>>(`/dns-records/by-domain/${domainId}/scan`);
    },
    import(
      domainId: string,
      input: ImportDnsRecordsInput,
    ): Promise<DataResponse<ImportDnsRecordsResponse>> {
      return api.post<DataResponse<ImportDnsRecordsResponse>>(
        `/dns-records/by-domain/${domainId}/import`,
        input,
      );
    },
    create(
      domainId: string,
      input: CreateDnsRecordInput,
    ): Promise<DataResponse<DnsRecordsMutationResponse>> {
      return api.post<DataResponse<DnsRecordsMutationResponse>>(
        `/dns-records/by-domain/${domainId}`,
        input,
      );
    },
    update(
      id: string,
      input: UpdateDnsRecordInput,
    ): Promise<DataResponse<DnsRecordsMutationResponse>> {
      return api.patch<DataResponse<DnsRecordsMutationResponse>>(`/dns-records/${id}`, input);
    },
    delete(id: string): Promise<DataResponse<DnsRecordsMutationResponse>> {
      return api.delete<DataResponse<DnsRecordsMutationResponse>>(`/dns-records/${id}`);
    },
    toggleLock(
      id: string,
      input: ToggleDnsRecordLockInput,
    ): Promise<DataResponse<DnsRecordsMutationResponse>> {
      return api.post<DataResponse<DnsRecordsMutationResponse>>(`/dns-records/${id}/lock`, input);
    },
  };
}
