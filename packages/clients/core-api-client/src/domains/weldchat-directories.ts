import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  DirectoryChannelItem,
  ListDirectoryChannelsQuery,
} from '../schemas/weldchat-directories';

export function createWeldchatDirectoriesApi(api: ClientApi) {
  return {
    listChannels(params: ListDirectoryChannelsQuery = {}): Promise<DataResponse<DirectoryChannelItem[]>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<DataResponse<DirectoryChannelItem[]>>(`/weldchat/directories/channels${query}`);
    },
  };
}
