/**
 * App-API WeldFlow client for task dependencies (`/api/task-dependencies`),
 * the computed schedule (`/api/project-schedule`) and phases with stage gates
 * (`/api/project-phases`). Served by flow-api.
 *
 * Request and response shapes are the shared Zod schemas and types in
 * `../schemas/project-schedule`, which flow-api validates against.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreatePhaseInput,
  CreateTaskDependencyInput,
  Phase,
  PhaseGate,
  PhaseGateRequestResult,
  PhaseList,
  PhaseSummary,
  ProjectSchedule,
  ReorderPhasesInput,
  ScheduleMoveInput,
  ScheduleMoveImpact,
  ScheduleMoveResult,
  ScheduleSettings,
  TaskDependency,
  UpdatePhaseInput,
  UpdateScheduleSettingsInput,
  UpdateTaskDependencyInput,
  WaiveCriterionInput,
} from '../schemas/project-schedule';

export type * from '../schemas/project-schedule';

export interface ListTaskDependenciesQuery {
  projectId?: string;
  taskId?: string;
  cursor?: string;
  /** 1 to 500, 100 by default. */
  limit?: number;
}

const depsBase = '/task-dependencies';
const scheduleBase = '/project-schedule';
const phasesBase = '/project-phases';

export function createProjectScheduleApi(api: ClientApi) {
  return {
    // Task dependencies ----------------------------------------------------
    listTaskDependencies(params: ListTaskDependenciesQuery): Promise<ListResponse<TaskDependency>> {
      return api.get(`${depsBase}${buildQueryString({ ...params })}`);
    },

    createTaskDependency(input: CreateTaskDependencyInput): Promise<DataResponse<TaskDependency>> {
      return api.post(depsBase, input);
    },

    updateTaskDependency(id: string, input: UpdateTaskDependencyInput): Promise<DataResponse<TaskDependency>> {
      return api.patch(`${depsBase}/${id}`, input);
    },

    deleteTaskDependency(id: string): Promise<void> {
      return api.delete(`${depsBase}/${id}`);
    },

    // Schedule -------------------------------------------------------------
    getProjectSchedule(projectId: string): Promise<DataResponse<ProjectSchedule>> {
      return api.get(`${scheduleBase}/${projectId}`);
    },

    /** What a move would do: the dependents it pushes and the effect on deliverables and go-live. Writes nothing. */
    previewScheduleMove(projectId: string, input: ScheduleMoveInput): Promise<DataResponse<ScheduleMoveImpact>> {
      return api.post(`${scheduleBase}/${projectId}/preview`, input);
    },

    /** The same move, written: the task and every dependent it pushes (auto-schedule on). */
    applyScheduleMove(projectId: string, input: ScheduleMoveInput): Promise<DataResponse<ScheduleMoveResult>> {
      return api.post(`${scheduleBase}/${projectId}/apply`, input);
    },

    getScheduleSettings(projectId: string): Promise<DataResponse<ScheduleSettings>> {
      return api.get(`${scheduleBase}/settings/${projectId}`);
    },

    updateScheduleSettings(projectId: string, input: UpdateScheduleSettingsInput): Promise<DataResponse<ScheduleSettings>> {
      return api.put(`${scheduleBase}/settings/${projectId}`, input);
    },

    // Phases and gates -----------------------------------------------------
    listPhases(projectId: string): Promise<DataResponse<PhaseList>> {
      return api.get(`${phasesBase}${buildQueryString({ projectId })}`);
    },

    /** The gate of a phase evaluated now, with the link to the data behind each criterion. */
    checkPhase(id: string): Promise<DataResponse<PhaseGate>> {
      return api.get(`${phasesBase}/${id}/check`);
    },

    createPhase(input: CreatePhaseInput): Promise<DataResponse<PhaseSummary>> {
      return api.post(phasesBase, input);
    },

    updatePhase(id: string, input: UpdatePhaseInput): Promise<DataResponse<PhaseSummary>> {
      return api.patch(`${phasesBase}/${id}`, input);
    },

    deletePhase(id: string): Promise<void> {
      return api.delete(`${phasesBase}/${id}`);
    },

    reorderPhases(input: ReorderPhasesInput): Promise<DataResponse<PhaseList>> {
      return api.post(`${phasesBase}/reorder`, input);
    },

    /** Tick or untick a manual criterion (project manager). */
    tickCriterion(id: string, index: number, met: boolean): Promise<DataResponse<PhaseGate>> {
      return api.patch(`${phasesBase}/${id}/criteria/${index}`, { met });
    },

    /** Waive an open criterion with a note (the sponsor). */
    waiveCriterion(id: string, input: WaiveCriterionInput): Promise<DataResponse<PhaseGate>> {
      return api.post(`${phasesBase}/${id}/waive`, input);
    },

    /** Ask the sponsor and one change board member to pass the gate. */
    requestGateApproval(id: string): Promise<DataResponse<PhaseGateRequestResult>> {
      return api.post(`${phasesBase}/${id}/request-approval`, {});
    },
  };
}

export type { Phase };
