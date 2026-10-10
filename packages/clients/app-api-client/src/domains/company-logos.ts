/**
 * App-API company logos domain client — `/api/company-logos/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import type { CompanyLogosResult } from '../schemas/company-logos';

export function createCompanyLogosApi(api: ClientApi) {
  return {
    /**
     * Resolve the logo for up to COMPANY_LOGO_BATCH_MAX domains. A POST, so the
     * domains of a workspace's customers stay out of URLs and access logs.
     */
    resolve(domains: string[]): Promise<DataResponse<CompanyLogosResult>> {
      return api.post<DataResponse<CompanyLogosResult>>('/company-logos/resolve', { domains });
    },
  };
}
