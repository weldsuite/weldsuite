/**
 * App-API services-outside-the-EU domain client: `/api/outside-eu-services`
 * (Rust backend, ADR OPS-026).
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  OutsideEuService,
  OutsideEuServices,
  SwitchOutsideEuServiceInput,
} from '../schemas/outside-eu-services';

export function createOutsideEuServicesApi(api: ClientApi) {
  return {
    /** Every service with its state, and the integration codes each covers. */
    list(): Promise<DataResponse<OutsideEuServices>> {
      return api.get<DataResponse<OutsideEuServices>>('/outside-eu-services');
    },

    /** Switch one on (with `acknowledgedOutsideEu: true`) or off (`settings:manage`). */
    switch(service: string, input: SwitchOutsideEuServiceInput): Promise<DataResponse<OutsideEuService>> {
      return api.put<DataResponse<OutsideEuService>>(`/outside-eu-services/${encodeURIComponent(service)}`, input);
    },
  };
}

export type OutsideEuServicesApi = ReturnType<typeof createOutsideEuServicesApi>;
