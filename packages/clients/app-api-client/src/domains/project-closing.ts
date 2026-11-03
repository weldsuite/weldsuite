/**
 * App-API WeldFlow closing client: lessons learned (`/api/project-lessons`),
 * closing a project (`/api/project-close`) and project templates
 * (`/api/project-templates`). Served by flow-api.
 *
 * Request and response shapes are the shared Zod schemas in
 * `../schemas/project-closing`, which flow-api validates against.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CloseChecklist,
  CreateLessonInput,
  CreateTemplateInput,
  HandoverInput,
  InstantiateResult,
  InstantiateTemplateInput,
  Lesson,
  LessonCategory,
  ProjectTemplate,
  ProjectTemplateDetail,
  PublishLessonsInput,
  PublishLessonsResult,
  RequestCloseInput,
  TemplateFromProjectInput,
  UpdateLessonInput,
  UpdateTemplateInput,
} from '../schemas/project-closing';

export type {
  Blueprint,
  BlueprintSummary,
  CloseBenefit,
  CloseCheck,
  CloseCheckKey,
  CloseChecklist,
  CloseDeliverable,
  CloseFinance,
  CloseRaidItem,
  CloseSignOff,
  CreateLessonInput,
  CreateTemplateInput,
  HandoverInput,
  InstantiateCopy,
  InstantiateResult,
  InstantiateTemplateInput,
  Lesson,
  LessonCategory,
  LessonPageLocale,
  ProjectTemplate,
  ProjectTemplateDetail,
  PublishLessonsInput,
  PublishLessonsResult,
  RequestCloseInput,
  TemplateFromProjectInput,
  UpdateLessonInput,
  UpdateTemplateInput,
} from '../schemas/project-closing';

export interface ListLessonsQuery {
  projectId?: string;
  category?: LessonCategory;
  search?: string;
  cursor?: string;
  /** 1 to 100, 50 by default. */
  limit?: number;
}

export interface ListTemplatesQuery {
  search?: string;
  shared?: boolean;
  cursor?: string;
  /** 1 to 100, 50 by default. */
  limit?: number;
}

const lessonsBase = '/project-lessons';
const closeBase = '/project-close';
const templatesBase = '/project-templates';

export function createProjectClosingApi(api: ClientApi) {
  return {
    // Lessons learned ------------------------------------------------------
    listLessons(params: ListLessonsQuery = {}): Promise<ListResponse<Lesson>> {
      return api.get(`${lessonsBase}${buildQueryString({ ...params })}`);
    },

    getLesson(id: string): Promise<DataResponse<Lesson>> {
      return api.get(`${lessonsBase}/${id}`);
    },

    createLesson(input: CreateLessonInput): Promise<DataResponse<Lesson>> {
      return api.post(lessonsBase, input);
    },

    /** Its author, or a project manager. */
    updateLesson(id: string, input: UpdateLessonInput): Promise<DataResponse<Lesson>> {
      return api.patch(`${lessonsBase}/${id}`, input);
    },

    /** Its author, or a project manager. */
    deleteLesson(id: string): Promise<void> {
      return api.delete(`${lessonsBase}/${id}`);
    },

    /** Vote for a lesson; voting twice changes nothing. */
    voteLesson(id: string): Promise<DataResponse<Lesson>> {
      return api.post(`${lessonsBase}/${id}/vote`, {});
    },

    unvoteLesson(id: string): Promise<DataResponse<Lesson>> {
      return api.delete(`${lessonsBase}/${id}/vote`);
    },

    /** One WeldKnow page with every lesson of the project, grouped by category. */
    publishLessons(input: PublishLessonsInput): Promise<DataResponse<PublishLessonsResult>> {
      return api.post(`${lessonsBase}/publish`, input);
    },

    // Closing a project ----------------------------------------------------
    /** The close checklist, computed from the project's tables. */
    getCloseChecklist(projectId: string): Promise<DataResponse<CloseChecklist>> {
      return api.get(`${closeBase}/${projectId}`);
    },

    /** New owners for open RAID items and benefits; answers the refreshed checklist. */
    handOver(projectId: string, input: HandoverInput): Promise<DataResponse<CloseChecklist>> {
      return api.post(`${closeBase}/${projectId}/handover`, input);
    },

    /** Ask the sponsor to sign off; answers the refreshed checklist. */
    requestSignOff(projectId: string, input: RequestCloseInput = {}): Promise<DataResponse<CloseChecklist>> {
      return api.post(`${closeBase}/${projectId}/request`, input);
    },

    // Templates ------------------------------------------------------------
    listTemplates(params: ListTemplatesQuery = {}): Promise<ListResponse<ProjectTemplate>> {
      return api.get(`${templatesBase}${buildQueryString({ ...params })}`);
    },

    /** The template with its blueprint. */
    getTemplate(id: string): Promise<DataResponse<ProjectTemplateDetail>> {
      return api.get(`${templatesBase}/${id}`);
    },

    createTemplate(input: CreateTemplateInput): Promise<DataResponse<ProjectTemplateDetail>> {
      return api.post(templatesBase, input);
    },

    updateTemplate(id: string, input: UpdateTemplateInput): Promise<DataResponse<ProjectTemplateDetail>> {
      return api.patch(`${templatesBase}/${id}`, input);
    },

    deleteTemplate(id: string): Promise<void> {
      return api.delete(`${templatesBase}/${id}`);
    },

    /** "Save as template": a blueprint built from the project. */
    saveProjectAsTemplate(projectId: string, input: TemplateFromProjectInput): Promise<DataResponse<ProjectTemplateDetail>> {
      return api.post(`${templatesBase}/from-project/${projectId}`, input);
    },

    /** "Create project": the whole project from the template, in one step. */
    createProjectFromTemplate(id: string, input: InstantiateTemplateInput): Promise<DataResponse<InstantiateResult>> {
      return api.post(`${templatesBase}/${id}/instantiate`, input);
    },
  };
}
