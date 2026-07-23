/**
 * DNS zones API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  ListDnsZonesQuery,
  CreateDnsZoneInput,
  UpdateDnsZoneInput,
  DnsZone,
} from '../schemas/dns-zones';

export function createDnsZonesApi(api: ClientApi) {
  return {
    list(params: ListDnsZonesQuery = {}): Promise<ListResponse<DnsZone>> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<DnsZone>>(`/dns-zones${qs}`);
    },
    byDomain(domainId: string): Promise<DataResponse<DnsZone>> {
      return api.get<DataResponse<DnsZone>>(`/dns-zones/by-domain/${domainId}`);
    },
    get(id: string): Promise<DataResponse<DnsZone>> {
      return api.get<DataResponse<DnsZone>>(`/dns-zones/${id}`);
    },
    create(input: CreateDnsZoneInput): Promise<DataResponse<DnsZone>> {
      return api.post<DataResponse<DnsZone>>('/dns-zones', input);
    },
    update(id: string, input: UpdateDnsZoneInput): Promise<DataResponse<DnsZone>> {
      return api.patch<DataResponse<DnsZone>>(`/dns-zones/${id}`, input);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`/dns-zones/${id}`);
    },
  };
}
