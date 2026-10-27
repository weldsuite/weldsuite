/**
 * App-API WeldPanel domain client — `/api/panel/*` (panel-api).
 *
 * Phase 1: projects (create, list, rename, domains, settings, pause, delete),
 * token rotation and the install check.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  CreatePanelProjectInput,
  PanelInstallInfo,
  PanelProjectDto,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '../schemas/weldpanel';

const projects = '/panel/projects';

export function createWeldPanelApi(api: ClientApi) {
  return {
    projects: {
      list(): Promise<ListResponse<PanelProjectDto>> {
        return api.get(projects);
      },
      get(id: string): Promise<DataResponse<PanelProjectDto>> {
        return api.get(`${projects}/${id}`);
      },
      create(input: CreatePanelProjectInput): Promise<DataResponse<PanelProjectDto>> {
        return api.post(projects, input);
      },
      /** Name, kind and allowed domains. */
      update(id: string, input: UpdatePanelProjectInput): Promise<DataResponse<PanelProjectDto>> {
        return api.patch(`${projects}/${id}`, input);
      },
      /** Collector and privacy settings, and pausing collection. */
      updateSettings(id: string, input: UpdatePanelProjectSettingsInput): Promise<DataResponse<PanelProjectDto>> {
        return api.patch(`${projects}/${id}/settings`, input);
      },
      /** Soft-deletes the project; the collector stops accepting its token at once. */
      remove(id: string): Promise<void> {
        return api.delete(`${projects}/${id}`);
      },
      /** Issues a new token; the old one stops working at once. */
      rotateToken(id: string): Promise<DataResponse<PanelProjectDto>> {
        return api.post(`${projects}/${id}/rotate-token`, {});
      },
      install(id: string): Promise<DataResponse<PanelInstallInfo>> {
        return api.get(`${projects}/${id}/install`);
      },
    },
  };
}

export type WeldPanelApi = ReturnType<typeof createWeldPanelApi>;
