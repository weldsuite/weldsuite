/**
 * Domains API factory (app-api).
 *
 * Typed wrapper around `/api/domains/*`. Consumed by the platform's
 * `useAppApi().domains.*`. Successor to `createWeldhostApi`, which targeted
 * the legacy `/api/weldhost/domains/*` core-api routes, and to the raw
 * `client.get('/host/domains/...')` calls that previously hit api-worker.
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListDomainsQuery,
  DomainSearchQuery,
  DomainCheckInput,
  CreateDomainInput,
  UpdateDomainInput,
  ExternalDomainInput,
  CheckoutInput,
  CompleteRegistrationInput,
  Domain,
  DomainSearchResult,
  CheckoutResponse,
  DashboardStats,
  ChartDataPoint,
  DomainListResponse,
  VerifyNameserversResponse,
  VerifyOwnershipResponse,
  RefreshZoneStatusResponse,
  AuthCodeResponse,
  RegistrationStatusResponse,
} from '../schemas/domains';

export function createDomainsApi(api: ClientApi) {
  return {
    // ── Dashboard ────────────────────────────────────────────────────────
    dashboard(): Promise<DataResponse<DashboardStats>> {
      return api.get<DataResponse<DashboardStats>>('/domains/dashboard');
    },
    dashboardChart(days?: number): Promise<DataResponse<ChartDataPoint[]>> {
      const qs = buildQueryString({ days });
      return api.get<DataResponse<ChartDataPoint[]>>(`/domains/dashboard/chart${qs}`);
    },
    dashboardRecent(limit?: number): Promise<DataResponse<Domain[]>> {
      const qs = buildQueryString({ limit });
      return api.get<DataResponse<Domain[]>>(`/domains/dashboard/recent${qs}`);
    },

    // ── Search / availability / checkout ─────────────────────────────────
    search(query: DomainSearchQuery): Promise<DataResponse<DomainSearchResult[]>> {
      const qs = buildQueryString(query as Record<string, unknown>);
      return api.get<DataResponse<DomainSearchResult[]>>(`/domains/search${qs}`);
    },
    check(input: DomainCheckInput): Promise<DataResponse<DomainSearchResult[]>> {
      return api.post<DataResponse<DomainSearchResult[]>>('/domains/check', input);
    },
    checkout(input: CheckoutInput): Promise<DataResponse<CheckoutResponse>> {
      return api.post<DataResponse<CheckoutResponse>>('/domains/checkout', input);
    },

    // ── List / get / mutate ──────────────────────────────────────────────
    list(params: ListDomainsQuery = {}): Promise<DomainListResponse> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<DomainListResponse>(`/domains${qs}`);
    },
    get(id: string): Promise<DataResponse<Domain>> {
      return api.get<DataResponse<Domain>>(`/domains/${id}`);
    },
    create(input: CreateDomainInput): Promise<DataResponse<Domain>> {
      return api.post<DataResponse<Domain>>('/domains', input);
    },
    update(id: string, input: UpdateDomainInput): Promise<DataResponse<Domain>> {
      return api.patch<DataResponse<Domain>>(`/domains/${id}`, input);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`/domains/${id}`);
    },

    // ── External domains (BYO registrar) ─────────────────────────────────
    addExternal(input: ExternalDomainInput): Promise<DataResponse<Domain & {
      verificationRecord: { name: string; type: 'TXT'; value: string };
    }>> {
      return api.post('/domains/external', input);
    },
    verifyOwnership(id: string): Promise<DataResponse<VerifyOwnershipResponse>> {
      return api.post<DataResponse<VerifyOwnershipResponse>>(`/domains/${id}/verify-ownership`);
    },
    refreshZoneStatus(id: string): Promise<DataResponse<RefreshZoneStatusResponse>> {
      return api.post<DataResponse<RefreshZoneStatusResponse>>(`/domains/${id}/refresh-zone-status`);
    },

    // ── Per-domain actions ───────────────────────────────────────────────
    sync(id: string): Promise<DataResponse<Domain>> {
      return api.post<DataResponse<Domain>>(`/domains/${id}/sync`);
    },
    toggleAutoRenew(id: string, enabled: boolean): Promise<DataResponse<Domain>> {
      return api.post<DataResponse<Domain>>(`/domains/${id}/toggle-auto-renew`, { enabled });
    },
    togglePrivacy(id: string, enabled: boolean): Promise<DataResponse<Domain>> {
      return api.post<DataResponse<Domain>>(`/domains/${id}/toggle-privacy`, { enabled });
    },
    toggleLock(id: string, locked: boolean): Promise<DataResponse<Domain>> {
      return api.post<DataResponse<Domain>>(`/domains/${id}/toggle-lock`, { locked });
    },
    verifyNameservers(id: string): Promise<VerifyNameserversResponse> {
      return api.post<VerifyNameserversResponse>(`/domains/${id}/verify-nameservers`);
    },
    getAuthCode(id: string): Promise<AuthCodeResponse> {
      return api.post<AuthCodeResponse>(`/domains/${id}/auth-code`);
    },

    // ── Registration polling + completion ────────────────────────────────
    getRegistrationStatus(registrationId: string): Promise<DataResponse<RegistrationStatusResponse>> {
      return api.get<DataResponse<RegistrationStatusResponse>>(
        `/domains/registrations/${registrationId}/status`,
      );
    },
    completeRegistration(
      registrationId: string,
      input: CompleteRegistrationInput = {},
    ): Promise<DataResponse<{ success: boolean; domainId: string; domain: Domain }>> {
      return api.post<DataResponse<{ success: boolean; domainId: string; domain: Domain }>>(
        `/domains/registrations/${registrationId}/complete`,
        input,
      );
    },
  };
}
