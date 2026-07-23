/**
 * App-API mail-weldmail domain client — flat `/api/mail-weldmail/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  CheckWeldMailAddressInput,
  ReserveWeldMailAddressInput,
} from '../schemas/mail-weldmail';

export type WeldMailAvailability =
  | { available: true; email: string; domain: string }
  | { available: false; reason: 'reserved' | 'taken' };

export interface WeldMailAddressRow {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  status: string;
  isDefault: boolean;
  createdAt: string;
}

export interface WeldMailListResult {
  addresses: WeldMailAddressRow[];
  total: number;
  /** null = unlimited */
  limit: number | null;
  enabled: boolean;
  domain: string;
}

export interface WeldMailDomainResult {
  domain: string;
}

export function createMailWeldMailApi(api: ClientApi) {
  return {
    domain(): Promise<DataResponse<WeldMailDomainResult>> {
      return api.get<DataResponse<WeldMailDomainResult>>('/mail-weldmail/domain');
    },

    check(data: CheckWeldMailAddressInput): Promise<DataResponse<WeldMailAvailability>> {
      return api.post<DataResponse<WeldMailAvailability>>('/mail-weldmail/check', data);
    },

    reserve(data: ReserveWeldMailAddressInput): Promise<DataResponse<WeldMailAddressRow>> {
      return api.post<DataResponse<WeldMailAddressRow>>('/mail-weldmail/reserve', data);
    },

    list(): Promise<DataResponse<WeldMailListResult>> {
      return api.get<DataResponse<WeldMailListResult>>('/mail-weldmail');
    },

    release(
      id: string,
    ): Promise<DataResponse<{ deleted: true; id: string; email: string }>> {
      return api.delete<DataResponse<{ deleted: true; id: string; email: string }>>(
        `/mail-weldmail/${id}`,
      );
    },
  };
}
