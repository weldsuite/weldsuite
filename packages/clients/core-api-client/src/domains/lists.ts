import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  ListEntity,
  CreateListInput,
  UpdateListInput,
  ListListsQueryV2,
  ListMember,
  AddListMembersInputV2,
} from '../schemas/lists';

/**
 * Lists domain client — `/api/weldcrm/lists/*`.
 *
 * Each list is scoped to one entity type via `kind` (`company` or `person`),
 * chosen at create time and immutable thereafter. Membership inserts and
 * smart-list filter rules are type-specific.
 */
export function createListsApi(api: ClientApi) {
  return {
    list(params: ListListsQueryV2 = {} as ListListsQueryV2): Promise<ListResponse<ListEntity>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ListEntity>>(`/weldcrm/lists${query}`);
    },

    get(id: string): Promise<DataResponse<ListEntity>> {
      return api.get<DataResponse<ListEntity>>(`/weldcrm/lists/${id}`);
    },

    create(data: CreateListInput): Promise<DataResponse<ListEntity>> {
      return api.post<DataResponse<ListEntity>>('/weldcrm/lists', data);
    },

    update(id: string, data: UpdateListInput): Promise<DataResponse<ListEntity>> {
      return api.patch<DataResponse<ListEntity>>(`/weldcrm/lists/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/weldcrm/lists/${id}`);
    },

    listMembers(id: string): Promise<DataResponse<ListMember[]>> {
      return api.get<DataResponse<ListMember[]>>(`/weldcrm/lists/${id}/members`);
    },

    addMembers(id: string, data: AddListMembersInputV2): Promise<DataResponse<{ added: number }>> {
      return api.post<DataResponse<{ added: number }>>(`/weldcrm/lists/${id}/members`, data);
    },

    removeMember(listId: string, entityId: string): Promise<void> {
      return api.delete<void>(`/weldcrm/lists/${listId}/members/${entityId}`);
    },
  };
}
