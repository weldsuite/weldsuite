import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  GithubConnection,
  GithubRepoLink,
  AvailableRepo,
  CreateRepoLinkInput,
  UpdateRepoLinkInput,
  InstallUrlQuery,
  ListLinkedReposQuery,
  DiscoverableInstallation,
  RecoverInstallationInput,
  GithubProjectLink,
  AvailableProjectV2,
  ProjectV2StatusFieldInfo,
  CreateProjectLinkInput,
  UpdateProjectLinkInput,
  ListLinkedProjectsQuery,
} from '../schemas/github';

export function createGithubApi(api: ClientApi) {
  return {
    // ====== Install / Connection ======

    getInstallUrl(params: InstallUrlQuery = {}): Promise<DataResponse<{ url: string }>> {
      return api.get<DataResponse<{ url: string }>>(
        `/workflow-github/install-url${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    getConnection(): Promise<DataResponse<GithubConnection | null>> {
      return api.get<DataResponse<GithubConnection | null>>('/workflow-github/connection');
    },

    disconnect(): Promise<void> {
      return api.delete<void>('/workflow-github/connection');
    },

    // ====== Repositories ======

    listAvailableRepos(): Promise<ListResponse<AvailableRepo>> {
      return api.get<ListResponse<AvailableRepo>>('/workflow-github/repos/available');
    },

    listLinkedRepos(params: ListLinkedReposQuery = {}): Promise<ListResponse<GithubRepoLink>> {
      return api.get<ListResponse<GithubRepoLink>>(
        `/workflow-github/repos/linked${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    linkRepo(input: CreateRepoLinkInput): Promise<DataResponse<GithubRepoLink>> {
      return api.post<DataResponse<GithubRepoLink>>('/workflow-github/repos/link', input);
    },

    updateRepoLink(linkId: string, input: UpdateRepoLinkInput): Promise<DataResponse<GithubRepoLink>> {
      return api.patch<DataResponse<GithubRepoLink>>(`/workflow-github/repos/${linkId}`, input);
    },

    unlinkRepo(linkId: string): Promise<void> {
      return api.delete<void>(`/workflow-github/repos/${linkId}`);
    },

    // ====== Sync ======

    triggerFullSync(linkId: string): Promise<DataResponse<{ runId: string }>> {
      return api.post<DataResponse<{ runId: string }>>(
        `/workflow-github/repos/${linkId}/sync`,
        {},
      );
    },

    // ====== GitHub Projects (v2) ======

    /** Projects (v2) visible to the installation, for the link picker. */
    listAvailableProjects(): Promise<ListResponse<AvailableProjectV2>> {
      return api.get<ListResponse<AvailableProjectV2>>('/workflow-github/projects/available');
    },

    /** The "Status" single-select field + options of a Project, for stage mapping. */
    listProjectStatusFields(nodeId: string): Promise<DataResponse<ProjectV2StatusFieldInfo>> {
      return api.get<DataResponse<ProjectV2StatusFieldInfo>>(
        `/workflow-github/projects/status-fields${buildQueryString({ nodeId })}`,
      );
    },

    /** Project links for this workspace, optionally filtered by WeldFlow project. */
    listLinkedProjects(
      params: ListLinkedProjectsQuery = {},
    ): Promise<ListResponse<GithubProjectLink>> {
      return api.get<ListResponse<GithubProjectLink>>(
        `/github-project-links${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    /** Link a GitHub Project (v2) to a WeldFlow project. */
    linkProject(input: CreateProjectLinkInput): Promise<DataResponse<GithubProjectLink>> {
      return api.post<DataResponse<GithubProjectLink>>('/github-project-links', input);
    },

    /** Update sync settings / status mapping for a project link. */
    updateProjectLink(
      linkId: string,
      input: UpdateProjectLinkInput,
    ): Promise<DataResponse<GithubProjectLink>> {
      return api.patch<DataResponse<GithubProjectLink>>(`/github-project-links/${linkId}`, input);
    },

    /** Unlink a GitHub Project from its WeldFlow project. */
    unlinkProject(linkId: string): Promise<void> {
      return api.delete<void>(`/github-project-links/${linkId}`);
    },

    /** Trigger a sync for a single project link. */
    triggerProjectSync(linkId: string): Promise<DataResponse<{ runId: string }>> {
      return api.post<DataResponse<{ runId: string }>>(
        `/github-project-links/${linkId}/sync`,
        {},
      );
    },

    // ====== Installation Discovery / Recovery ======

    listDiscoverableInstallations(): Promise<ListResponse<DiscoverableInstallation>> {
      return api.get<ListResponse<DiscoverableInstallation>>(
        '/workflow-github/installations/discoverable',
      );
    },

    recoverInstallation(input: RecoverInstallationInput): Promise<DataResponse<GithubConnection>> {
      return api.post<DataResponse<GithubConnection>>('/workflow-github/recover', input);
    },
  };
}
