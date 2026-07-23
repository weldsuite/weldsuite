/**
 * GitHub Integration Query Hooks
 *
 * Provides typed TanStack Query hooks for the GitHub integration.
 * Consumers need `weldconnect:integrations:github:manage` permission.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateRepoLinkInput,
  UpdateRepoLinkInput,
  RecoverInstallationInput,
  CreateProjectLinkInput,
  UpdateProjectLinkInput,
} from '@weldsuite/core-api-client/schemas/github';

// ============================================================================
// Query Keys
// ============================================================================

const githubKeys = {
  all: ['github'] as const,
  connection: () => [...githubKeys.all, 'connection'] as const,
  repos: () => [...githubKeys.all, 'repos'] as const,
  availableRepos: () => [...githubKeys.repos(), 'available'] as const,
  linkedRepos: (projectId?: string) =>
    [...githubKeys.repos(), 'linked', projectId ?? 'all'] as const,
  discoverableInstallations: () => [...githubKeys.all, 'discoverable'] as const,
  projects: () => [...githubKeys.all, 'projects'] as const,
  availableProjects: () => [...githubKeys.projects(), 'available'] as const,
  linkedProjects: (projectId?: string) =>
    [...githubKeys.projects(), 'linked', projectId ?? 'all'] as const,
  projectStatusFields: (nodeId?: string) =>
    [...githubKeys.projects(), 'status-fields', nodeId ?? 'none'] as const,
};

// ============================================================================
// Queries
// ============================================================================

/**
 * Fetch the current GitHub App connection for this workspace.
 * Returns null when no connection exists.
 */
export function useGithubConnection() {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.connection(),
    queryFn: () => github.getConnection(),
    staleTime: 30_000,
  });
}

/**
 * Fetch all repositories accessible to the GitHub App installation.
 * Only available when a connection exists.
 */
export function useAvailableRepos(enabled = true) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.availableRepos(),
    queryFn: () => github.listAvailableRepos(),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Fetch repositories linked to this workspace, optionally filtered by project.
 */
export function useLinkedRepos(projectId?: string) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.linkedRepos(projectId),
    queryFn: () => github.listLinkedRepos({ projectId }),
    staleTime: 30_000,
  });
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Get the GitHub App install URL and open it in a new tab.
 */
export function useGetInstallUrl() {
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (params: { projectId?: string; returnTo?: string }) =>
      github.getInstallUrl(params),
  });
}

/**
 * Disconnect the GitHub integration for this workspace.
 */
export function useDisconnectGithub() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: () => github.disconnect(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
  });
}

/**
 * Link a GitHub repository to a WeldFlow project.
 */
function useLinkRepo() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (input: CreateRepoLinkInput) => github.linkRepo(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.repos() });
    },
  });
}

/**
 * Update sync settings for a linked repository.
 */
export function useUpdateRepoLink(linkId: string) {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (input: UpdateRepoLinkInput) => github.updateRepoLink(linkId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.repos() });
    },
  });
}

/**
 * Unlink a GitHub repository.
 */
export function useUnlinkRepo() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (linkId: string) => github.unlinkRepo(linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.repos() });
    },
  });
}

/**
 * Fetch GitHub App installations that are discoverable for recovery.
 * Only fetches when `enabled` is true (i.e. the recover dialog is open).
 */
export function useDiscoverableInstallations(enabled: boolean) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.discoverableInstallations(),
    queryFn: () => github.listDiscoverableInstallations(),
    enabled,
    staleTime: 0,
  });
}

/**
 * Recover an existing GitHub App installation into this workspace.
 */
export function useRecoverInstallation() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (input: RecoverInstallationInput) => github.recoverInstallation(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
  });
}

/**
 * Trigger a full re-sync for a linked repository.
 */
export function useGithubSync() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (linkId: string) => github.triggerFullSync(linkId),
    onSuccess: (_data, linkId) => {
      queryClient.invalidateQueries({ queryKey: githubKeys.linkedRepos() });
    },
  });
}

// ============================================================================
// GitHub Projects (v2)
// ============================================================================

/**
 * Fetch the GitHub Projects (v2) visible to the installation (link picker).
 */
export function useAvailableProjects(enabled = true) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.availableProjects(),
    queryFn: () => github.listAvailableProjects(),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Fetch the "Status" single-select field + options of a Project (for mapping).
 * Only fetches when a nodeId is provided.
 */
export function useProjectStatusFields(nodeId: string | null) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.projectStatusFields(nodeId ?? undefined),
    queryFn: () => github.listProjectStatusFields(nodeId as string),
    enabled: !!nodeId,
    staleTime: 60_000,
  });
}

/**
 * Fetch GitHub Project links for this workspace, optionally filtered by project.
 */
export function useLinkedProjects(projectId?: string) {
  const { github } = useAppApi();

  return useQuery({
    queryKey: githubKeys.linkedProjects(projectId),
    queryFn: () => github.listLinkedProjects({ projectId }),
    staleTime: 30_000,
  });
}

/**
 * Link a GitHub Project (v2) to a WeldFlow project.
 */
export function useLinkProject() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (input: CreateProjectLinkInput) => github.linkProject(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.projects() });
    },
  });
}

/**
 * Update sync settings / status mapping for a project link.
 */
export function useUpdateProjectLink(linkId: string) {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (input: UpdateProjectLinkInput) => github.updateProjectLink(linkId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.projects() });
    },
  });
}

/**
 * Unlink a GitHub Project.
 */
export function useUnlinkProject() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (linkId: string) => github.unlinkProject(linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.projects() });
    },
  });
}

/**
 * Trigger a sync for a single project link.
 */
export function useProjectSync() {
  const queryClient = useQueryClient();
  const { github } = useAppApi();

  return useMutation({
    mutationFn: (linkId: string) => github.triggerProjectSync(linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.linkedProjects() });
    },
  });
}
