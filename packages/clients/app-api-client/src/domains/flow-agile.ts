/**
 * App-API WeldFlow agile client: sprints (`/api/sprints`, with start,
 * complete and report), epic roll-ups (`/api/tasks/epics`), a project's
 * delivery setting (`/api/projects/:id/delivery`), the agile fields of a task
 * and sprint retros (`/api/project-lessons` with a `sprintId`).
 *
 * Served by the Rust backend only; shapes in `../schemas/flow-agile`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CompleteSprintInput,
  CompleteSprintResult,
  CreateRetroCardInput,
  CreateSprintInput,
  DeliverySettings,
  DeliverySettingsInput,
  EpicRollup,
  RetroCard,
  Sprint,
  SprintReport,
  SprintStatus,
  StartSprintInput,
  TaskAgileInput,
  UpdateRetroCardInput,
  UpdateSprintInput,
} from '../schemas/flow-agile';

export type {
  BurndownPoint,
  CarryOverTarget,
  CompleteSprintInput,
  CompleteSprintResult,
  CreateRetroCardInput,
  CreateSprintInput,
  DeliveryApproach,
  DeliverySettings,
  DeliverySettingsInput,
  EpicRollup,
  ItemType,
  ItemTypeNaming,
  ItemTypeSettings,
  RetroCard,
  RetroCategory,
  Sprint,
  SprintReport,
  SprintStatus,
  StartSprintInput,
  TaskAgileInput,
  UpdateRetroCardInput,
  UpdateSprintInput,
} from '../schemas/flow-agile';

export interface ListSprintsQuery {
  projectId: string;
  status?: SprintStatus;
  search?: string;
  cursor?: string;
  /** 1 to 100, 25 by default. */
  limit?: number;
}

const sprintsBase = '/sprints';
const lessonsBase = '/project-lessons';

export function createFlowAgileApi(api: ClientApi) {
  return {
    // Sprints --------------------------------------------------------------
    listSprints(params: ListSprintsQuery): Promise<ListResponse<Sprint>> {
      return api.get(`${sprintsBase}${buildQueryString({ ...params })}`);
    },

    getSprint(id: string): Promise<DataResponse<Sprint>> {
      return api.get(`${sprintsBase}/${id}`);
    },

    createSprint(input: CreateSprintInput): Promise<DataResponse<{ id: string }>> {
      return api.post(sprintsBase, input);
    },

    updateSprint(id: string, input: UpdateSprintInput): Promise<DataResponse<{ id: string }>> {
      return api.patch(`${sprintsBase}/${id}`, input);
    },

    /** Its items go back to the backlog. */
    deleteSprint(id: string): Promise<void> {
      return api.delete(`${sprintsBase}/${id}`);
    },

    /** Only a planned sprint, and only when no other sprint of the project is active (409). */
    startSprint(id: string, input: StartSprintInput = {}): Promise<DataResponse<Sprint>> {
      return api.post(`${sprintsBase}/${id}/start`, input);
    },

    /** Moves the unfinished items on and freezes the report. */
    completeSprint(id: string, input: CompleteSprintInput = {}): Promise<DataResponse<CompleteSprintResult>> {
      return api.post(`${sprintsBase}/${id}/complete`, input);
    },

    /** Live while the sprint runs, frozen once it completed. */
    getSprintReport(id: string): Promise<DataResponse<SprintReport>> {
      return api.get(`${sprintsBase}/${id}/report`);
    },

    // Epics ----------------------------------------------------------------
    /** The project's epics (and features) with their items rolled up. */
    listEpics(projectId: string): Promise<DataResponse<EpicRollup[]>> {
      return api.get(`/tasks/epics${buildQueryString({ projectId })}`);
    },

    /** Type, sprint, epic, story points or acceptance criteria of one task. */
    updateTaskAgile(taskId: string, input: TaskAgileInput): Promise<DataResponse<{ id: string }>> {
      return api.patch(`/tasks/${taskId}`, input);
    },

    // Delivery approach ----------------------------------------------------
    /** The whole setting; a project manager only. Answers it with defaults filled. */
    updateDelivery(projectId: string, input: DeliverySettingsInput): Promise<DataResponse<DeliverySettings>> {
      return api.put(`/projects/${projectId}/delivery`, input);
    },

    // Retros ---------------------------------------------------------------
    listRetroCards(projectId: string, sprintId: string): Promise<ListResponse<RetroCard>> {
      return api.get(`${lessonsBase}${buildQueryString({ projectId, sprintId, limit: 100 })}`);
    },

    createRetroCard(input: CreateRetroCardInput): Promise<DataResponse<RetroCard>> {
      return api.post(lessonsBase, input);
    },

    /** Its author, or a project manager. */
    updateRetroCard(id: string, input: UpdateRetroCardInput): Promise<DataResponse<RetroCard>> {
      return api.patch(`${lessonsBase}/${id}`, input);
    },

    deleteRetroCard(id: string): Promise<void> {
      return api.delete(`${lessonsBase}/${id}`);
    },

    voteRetroCard(id: string): Promise<DataResponse<RetroCard>> {
      return api.post(`${lessonsBase}/${id}/vote`, {});
    },

    unvoteRetroCard(id: string): Promise<DataResponse<RetroCard>> {
      return api.delete(`${lessonsBase}/${id}/vote`);
    },
  };
}

export type FlowAgileApi = ReturnType<typeof createFlowAgileApi>;
