import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Party,
  PartyWithIdentity,
  UpdatePartyInput,
  ListPartiesQuery,
} from '../schemas/parties';

/**
 * Parties domain client — `/api/weldcrm/parties/*`.
 *
 * Read API for the counterparty wrapper. Every transactional artifact
 * (invoice, order, ticket, meeting, deal) references `parties.id` via its
 * `counterpartyId` column — call `get()` here to dereference into the
 * wrapped Company or Person, plus the commercial profile (billing address,
 * payment terms, currency).
 *
 * Identity mutations (name, email, industry, title) go through the Company
 * or Person APIs, not here. Only commercial-relationship fields are
 * writable on this surface.
 */
export function createPartiesApi(api: ClientApi) {
  return {
    list(params: ListPartiesQuery = {} as ListPartiesQuery): Promise<ListResponse<Party>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Party>>(`/weldcrm/parties${query}`);
    },

    get(id: string): Promise<DataResponse<PartyWithIdentity>> {
      return api.get<DataResponse<PartyWithIdentity>>(`/weldcrm/parties/${id}`);
    },

    update(id: string, data: UpdatePartyInput): Promise<DataResponse<Party>> {
      return api.patch<DataResponse<Party>>(`/weldcrm/parties/${id}`, data);
    },
  };
}
