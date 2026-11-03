/**
 * WeldFlow closing hooks: lessons learned, the close checklist and project
 * templates (project-management slice F).
 *
 * Every query lives under `closingKeys.all`. `platformSyncMap` invalidates that
 * root for `project_lesson` and `project_template` events (the checklist counts
 * lessons), so keep the root in step with `lib/realtime/sync-map.ts`. The
 * mutations that change more than their own list also refresh the project
 * queries (a closed project, a new project).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { raidKeys } from '@/hooks/queries/use-project-control-queries';
import type {
  CloseChecklist,
  CreateLessonInput,
  HandoverInput,
  InstantiateTemplateInput,
  Lesson,
  ProjectTemplate,
  PublishLessonsInput,
  RequestCloseInput,
  TemplateFromProjectInput,
  UpdateLessonInput,
  UpdateTemplateInput,
} from '@weldsuite/app-api-client/domains/project-closing';

export const closingKeys = {
  all: ['project-closing'] as const,
  checklists: () => [...closingKeys.all, 'checklist'] as const,
  checklist: (projectId: string) => [...closingKeys.checklists(), projectId] as const,
  lessons: () => [...closingKeys.all, 'lessons'] as const,
  lessonList: (projectId: string) => [...closingKeys.lessons(), projectId] as const,
  templates: () => [...closingKeys.all, 'templates'] as const,
  templateList: (search: string) => [...closingKeys.templates(), 'list', search] as const,
  templateDetail: (id: string) => [...closingKeys.templates(), 'detail', id] as const,
};

/** Rows per request: the most `GET /api/project-lessons` returns. */
const LESSON_PAGE_SIZE = 100;
/** A retrospective has tens of lessons; this only stops a runaway cursor. */
const LESSON_MAX_PAGES = 20;

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

type QueryClient = ReturnType<typeof useQueryClient>;

// ---------------------------------------------------------------------------
// The close checklist
// ---------------------------------------------------------------------------

/** The checklist of the close page, computed by the API from the project's tables. */
export function useCloseChecklist(projectId: string) {
  const { projectClosing } = useAppApi();

  return useQuery({
    queryKey: closingKeys.checklist(projectId),
    queryFn: () => projectClosing.getCloseChecklist(projectId),
    select: (res): CloseChecklist => res.data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

/** What a hand-over or a sign-off request changes: the checklist, the register and the project. */
function invalidateClose(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: closingKeys.checklists() });
  qc.invalidateQueries({ queryKey: raidKeys.all });
  return qc.invalidateQueries({ queryKey: projectKeys.all });
}

/** New owners for open RAID items and benefits. */
export function useHandOver(projectId: string) {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: HandoverInput) => projectClosing.handOver(projectId, input),
    onSuccess: () => invalidateClose(qc),
  });
}

/** Ask the sponsor to sign the project off. */
export function useRequestSignOff(projectId: string) {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: RequestCloseInput = {}) => projectClosing.requestSignOff(projectId, input),
    onSuccess: () => invalidateClose(qc),
  });
}

// ---------------------------------------------------------------------------
// Lessons learned
// ---------------------------------------------------------------------------

/** Every lesson of a project. The board groups, sorts and counts on the client. */
export function useLessons(projectId: string, enabled = true) {
  const { projectClosing } = useAppApi();

  return useQuery({
    queryKey: closingKeys.lessonList(projectId),
    queryFn: async (): Promise<Lesson[]> => {
      const lessons: Lesson[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LESSON_MAX_PAGES; page++) {
        const res = await projectClosing.listLessons({ projectId, limit: LESSON_PAGE_SIZE, cursor });
        lessons.push(...res.data);
        if (!res.pagination?.hasMore || !res.pagination.cursor) break;
        cursor = res.pagination.cursor;
      }
      return lessons;
    },
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

/** A lesson write changes the board and the checklist's lesson counts. */
function invalidateLessons(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: closingKeys.all });
}

export function useCreateLesson() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateLessonInput) => projectClosing.createLesson(input),
    onSuccess: () => invalidateLessons(qc),
  });
}

export function useUpdateLesson() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: UpdateLessonInput }) => projectClosing.updateLesson(input.id, input.data),
    onSuccess: () => invalidateLessons(qc),
  });
}

export function useDeleteLesson() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => projectClosing.deleteLesson(id),
    onSuccess: () => invalidateLessons(qc),
  });
}

/**
 * Vote or take the vote back. The board updates at once from the answer, so a
 * vote does not wait for the refetch; the refetch settles any other change.
 */
export function useToggleLessonVote(projectId: string) {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; vote: boolean }) =>
      input.vote ? projectClosing.voteLesson(input.id) : projectClosing.unvoteLesson(input.id),
    onSuccess: (res) => {
      qc.setQueryData<Lesson[]>(closingKeys.lessonList(projectId), (lessons) =>
        lessons?.map((lesson) => (lesson.id === res.data.id ? res.data : lesson)),
      );
      return qc.invalidateQueries({ queryKey: closingKeys.all });
    },
  });
}

/** One WeldKnow page with every lesson of the project. */
export function usePublishLessons() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: PublishLessonsInput) => projectClosing.publishLessons(input),
    onSuccess: () => invalidateLessons(qc),
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** The templates this person may use (shared ones and their own), without blueprints. */
export function useTemplates(search = '') {
  const { projectClosing } = useAppApi();

  return useQuery({
    queryKey: closingKeys.templateList(search),
    queryFn: async (): Promise<ProjectTemplate[]> => {
      const res = await projectClosing.listTemplates({ search: search || undefined, limit: 100 });
      return res.data;
    },
    retry: retryUnlessClientError,
  });
}

/** One template with its blueprint: the preview of what it creates. */
export function useTemplate(id: string | null) {
  const { projectClosing } = useAppApi();

  return useQuery({
    queryKey: closingKeys.templateDetail(id ?? ''),
    queryFn: () => projectClosing.getTemplate(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

function invalidateTemplates(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: closingKeys.templates() });
}

/** "Save as template": a blueprint built from a project. */
export function useSaveProjectAsTemplate() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { projectId: string; data: TemplateFromProjectInput }) =>
      projectClosing.saveProjectAsTemplate(input.projectId, input.data),
    onSuccess: () => invalidateTemplates(qc),
  });
}

export function useUpdateTemplate() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: UpdateTemplateInput }) => projectClosing.updateTemplate(input.id, input.data),
    onSuccess: () => invalidateTemplates(qc),
  });
}

export function useDeleteTemplate() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => projectClosing.deleteTemplate(id),
    onSuccess: () => invalidateTemplates(qc),
  });
}

/** "Create project": the whole project from a template. */
export function useCreateProjectFromTemplate() {
  const { projectClosing } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: InstantiateTemplateInput }) =>
      projectClosing.createProjectFromTemplate(input.id, input.data),
    onSuccess: () => {
      invalidateTemplates(qc);
      return qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}
