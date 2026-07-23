import type { ClientApi, DataResponse } from '../types';
import type { DraftItem, UpsertDraftInput } from '../schemas/weldchat-drafts';

export function createWeldchatDraftsApi(api: ClientApi) {
  return {
    list(): Promise<DataResponse<DraftItem[]>> {
      return api.get<DataResponse<DraftItem[]>>('/weldchat/drafts');
    },

    upsert(data: UpsertDraftInput): Promise<DataResponse<DraftItem | null>> {
      return api.put<DataResponse<DraftItem | null>>('/weldchat/drafts', data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/weldchat/drafts/${id}`);
    },
  };
}
