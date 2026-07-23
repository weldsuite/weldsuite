import { z } from 'zod';

// ============================================================================
// Entity Schemas
// ============================================================================

export const GithubConnectionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  installationId: z.number(),
  appSlug: z.string(),
  ownerType: z.enum(['user', 'org']),
  ownerLogin: z.string(),
  status: z.enum(['active', 'suspended', 'revoked']),
  scopes: z.array(z.string()).nullable(),
  createdBy: z.string().nullable(),
  installedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GithubRepoLinkSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  projectId: z.string().nullable(),
  repoId: z.number(),
  repoFullName: z.string(),
  defaultBranch: z.string().nullable(),
  syncIssues: z.boolean(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
  lastSyncedAt: z.string().nullable(),
  syncCursor: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GithubIssueSyncMapSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectLinkId: z.string(),
  taskId: z.string(),
  projectItemNodeId: z.string(),
  issueNodeId: z.string().nullable(),
  issueNumber: z.number(),
  repoId: z.number().nullable(),
  lastSyncedTaskUpdatedAt: z.string().nullable(),
  lastSyncedIssueUpdatedAt: z.string().nullable(),
  lastWriterSide: z.enum(['task', 'issue']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ----------------------------------------------------------------------------
// GitHub Project (v2) links — one WeldFlow project ↔ one GitHub Project
// ----------------------------------------------------------------------------

/** Maps a GitHub Project "Status" single-select option to a WeldFlow stage. */
export const GithubProjectStatusOptionMappingSchema = z.object({
  githubOptionId: z.string(),
  githubOptionName: z.string(),
  stageId: z.string().nullable(),
});

export const GithubProjectLinkSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  projectId: z.string(),
  projectV2NodeId: z.string(),
  projectV2Number: z.number(),
  projectTitle: z.string().nullable(),
  ownerType: z.enum(['user', 'org']),
  ownerLogin: z.string(),
  repoId: z.number().nullable(),
  repoFullName: z.string().nullable(),
  statusFieldId: z.string().nullable(),
  statusOptionMap: z.array(GithubProjectStatusOptionMappingSchema).nullable(),
  syncIssues: z.boolean(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  syncCursor: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ============================================================================
// Input Schemas
// ============================================================================

export const LinkRepoInputSchema = z.object({
  projectId: z.string().nullish(),
  repoId: z.number().int().positive(),
  repoFullName: z.string().min(1),
  defaultBranch: z.string().optional(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).default('bidirectional'),
  syncIssues: z.boolean().default(true),
});

export const UpdateRepoLinkInputSchema = z.object({
  projectId: z.string().nullish(),
  defaultBranch: z.string().optional(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
  syncIssues: z.boolean().optional(),
});

export const ListLinkedReposQuerySchema = z.object({
  projectId: z.string().nullish(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export const InstallUrlQuerySchema = z.object({
  projectId: z.string().nullish(),
  returnTo: z.string().optional(),
});

// ----- GitHub Project (v2) link inputs -----

export const LinkProjectInputSchema = z.object({
  projectId: z.string().min(1), // WeldFlow project id
  projectV2NodeId: z.string().min(1),
  projectV2Number: z.number().int().positive(),
  projectTitle: z.string().optional(),
  ownerType: z.enum(['user', 'org']),
  ownerLogin: z.string().min(1),
  repoId: z.number().int().positive().optional(),
  repoFullName: z.string().optional(),
  statusFieldId: z.string().optional(),
  statusOptionMap: z.array(GithubProjectStatusOptionMappingSchema).optional(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).default('bidirectional'),
  syncIssues: z.boolean().default(true),
});

export const UpdateProjectLinkInputSchema = z.object({
  projectTitle: z.string().optional(),
  statusFieldId: z.string().optional(),
  statusOptionMap: z.array(GithubProjectStatusOptionMappingSchema).optional(),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
  syncIssues: z.boolean().optional(),
});

export const ListLinkedProjectsQuerySchema = z.object({
  projectId: z.string().nullish(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export const ProjectStatusFieldsQuerySchema = z.object({
  nodeId: z.string().min(1), // GitHub Project (v2) GraphQL node id
});

// ============================================================================
// Inferred Types
// ============================================================================

export type GithubConnection = z.infer<typeof GithubConnectionSchema>;
export type GithubRepoLink = z.infer<typeof GithubRepoLinkSchema>;
export type GithubIssueSyncMap = z.infer<typeof GithubIssueSyncMapSchema>;
export type GithubProjectLink = z.infer<typeof GithubProjectLinkSchema>;
export type GithubProjectStatusOptionMapping = z.infer<
  typeof GithubProjectStatusOptionMappingSchema
>;

export type CreateRepoLinkInput = z.infer<typeof LinkRepoInputSchema>;
export type UpdateRepoLinkInput = z.infer<typeof UpdateRepoLinkInputSchema>;
export type ListLinkedReposQuery = z.input<typeof ListLinkedReposQuerySchema>;
export type InstallUrlQuery = z.infer<typeof InstallUrlQuerySchema>;

export type CreateProjectLinkInput = z.infer<typeof LinkProjectInputSchema>;
export type UpdateProjectLinkInput = z.infer<typeof UpdateProjectLinkInputSchema>;
export type ListLinkedProjectsQuery = z.input<typeof ListLinkedProjectsQuerySchema>;
export type ProjectStatusFieldsQuery = z.infer<typeof ProjectStatusFieldsQuerySchema>;

// ============================================================================
// Available Repo Shape (from GitHub API, not DB)
// ============================================================================

export interface AvailableRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

// ============================================================================
// Available Project (v2) + Status Field Shapes (from GitHub GraphQL, not DB)
// ============================================================================

/** A GitHub Project (v2) the installation can see, for the link picker. */
export interface AvailableProjectV2 {
  nodeId: string; // GraphQL global id, e.g. "PVT_kwDO..."
  number: number; // org/user-scoped project number
  title: string;
  ownerType: 'user' | 'org';
  ownerLogin: string;
  url: string;
  shortDescription: string | null;
  closed: boolean;
}

/** A single option of a Project's "Status" single-select field. */
export interface ProjectV2StatusOption {
  id: string;
  name: string;
}

/** The Status single-select field of a Project (v2), for stage mapping. */
export interface ProjectV2StatusFieldInfo {
  fieldId: string | null; // null when the Project has no Status field
  fieldName: string | null;
  options: ProjectV2StatusOption[];
}

// ============================================================================
// Discoverable Installations (from GitHub App API, not DB)
// ============================================================================

export const DiscoverableInstallationSchema = z.object({
  id: z.number(),
  accountLogin: z.string(),
  accountType: z.enum(['User', 'Organization']),
  appSlug: z.string(),
  repositorySelection: z.string(),
});

export const RecoverInstallationInputSchema = z.object({
  installationId: z.number().int().positive(),
});

export type DiscoverableInstallation = z.infer<typeof DiscoverableInstallationSchema>;
export type RecoverInstallationInput = z.infer<typeof RecoverInstallationInputSchema>;
