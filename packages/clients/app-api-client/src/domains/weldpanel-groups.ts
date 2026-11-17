/**
 * App-API WeldPanel group analytics client — group types and group profiles
 * (panel-api). Shapes: `schemas/weldpanel-groups.ts`.
 *
 * Permissions: group types read with `panel_reports:read` and change with
 * `panel_reports:create|update|delete`; groups read with `panel_people:read`
 * and are deleted with `panel_people:delete`.
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  CreatePanelGroupTypeInput,
  PanelGroupDto,
  PanelGroupListParams,
  PanelGroupProfileDto,
  PanelGroupTypeDto,
  UpdatePanelGroupTypeInput,
} from '../schemas/weldpanel-groups';

const panel = '/panel';

function groupPath(groupType: string, groupKey: string): string {
  return `${panel}/groups/${encodeURIComponent(groupType)}/${encodeURIComponent(groupKey)}`;
}

export function createWeldPanelGroupsApi(api: ClientApi) {
  return {
    /** The project's group types: configured rows and the types it collects without one (`id: null`). */
    listGroupTypes(projectId: string): Promise<ListResponse<PanelGroupTypeDto>> {
      return api.get(`${panel}/group-types${buildQueryString({ projectId })}`);
    },
    /** Takes one of the project's five slots; 409 `GROUP_TYPE_LIMIT` when none is free. */
    createGroupType(input: CreatePanelGroupTypeInput): Promise<DataResponse<PanelGroupTypeDto>> {
      return api.post(`${panel}/group-types`, input);
    },
    /** Names and the CRM match property; the type itself never changes. */
    updateGroupType(id: string, input: UpdatePanelGroupTypeInput): Promise<DataResponse<PanelGroupTypeDto>> {
      return api.patch(`${panel}/group-types/${id}`, input);
    },
    /** Removes the configuration and frees the slot; the profiles stay and come back if the type is taken again. */
    deleteGroupType(id: string): Promise<void> {
      return api.delete(`${panel}/group-types/${id}`);
    },

    /** One type's groups, most recently seen first; `search` matches the key and the name. */
    listGroups(params: PanelGroupListParams): Promise<ListResponse<PanelGroupDto>> {
      return api.get(`${panel}/groups${buildQueryString({ ...params })}`);
    },
    /** The profile, recent events, members and the matched WeldCRM company. */
    getGroup(projectId: string, groupType: string, groupKey: string, params: { days?: number } = {}): Promise<DataResponse<PanelGroupProfileDto>> {
      return api.get(`${groupPath(groupType, groupKey)}${buildQueryString({ projectId, ...params })}`);
    },
    /** Deletes the group's profile (`panel_people:delete`); its events keep the `$group_<type>` property. */
    deleteGroup(projectId: string, groupType: string, groupKey: string): Promise<void> {
      return api.delete(`${groupPath(groupType, groupKey)}${buildQueryString({ projectId })}`);
    },
  };
}

export type WeldPanelGroupsApi = ReturnType<typeof createWeldPanelGroupsApi>;
