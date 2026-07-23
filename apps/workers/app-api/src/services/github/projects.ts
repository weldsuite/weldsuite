/**
 * GitHub Projects (v2) Service
 *
 * Two responsibilities:
 *   1. GraphQL reads against GitHub for the link picker — list the Projects (v2)
 *      visible to an installation and read a Project's "Status" single-select
 *      field options (for stage mapping).
 *   2. DB CRUD for `githubProjectLinks` — one WeldFlow project ↔ one GitHub
 *      Project. All DB queries are scoped by workspaceId.
 *
 * Projects v2 is GraphQL-only (no REST). The installation access token minted
 * by `auth.ts` authorizes GraphQL too, provided the App has the org "Projects"
 * permission granted (see Phase 0 of the rollout).
 *
 * Cloudflare Workers compatibility: uses fetch + Web Crypto only.
 */

import { eq, and, isNull, desc } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type {
  AvailableProjectV2,
  ProjectV2StatusFieldInfo,
  CreateProjectLinkInput,
  UpdateProjectLinkInput,
} from '@weldsuite/core-api-client/schemas/github';

const { githubProjectLinks } = schema;

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

// ============================================================================
// GraphQL plumbing
// ============================================================================

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WeldSuite-App-API',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub GraphQL request failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as GraphqlResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) {
    throw new Error('GitHub GraphQL response missing data');
  }
  return json.data;
}

// ============================================================================
// Available Projects (v2) — from GitHub
// ============================================================================

interface ProjectV2Node {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
}

interface ProjectsV2Connection {
  nodes: ProjectV2Node[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface ProjectsV2OwnerResult {
  organization?: { projectsV2: ProjectsV2Connection } | null;
  user?: { projectsV2: ProjectsV2Connection } | null;
}

const PROJECTS_V2_QUERY = /* GraphQL */ `
  query ($login: String!, $cursor: String) {
    OWNER_FIELD(login: $login) {
      projectsV2(first: 100, after: $cursor) {
        nodes {
          id
          number
          title
          shortDescription
          url
          closed
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * List the Projects (v2) owned by the account that installed the App.
 * Paginates through all pages.
 */
export async function listAvailableProjectsV2(
  token: string,
  ownerLogin: string,
  ownerType: 'user' | 'org',
): Promise<AvailableProjectV2[]> {
  const ownerField = ownerType === 'org' ? 'organization' : 'user';
  const query = PROJECTS_V2_QUERY.replace('OWNER_FIELD', ownerField);

  const projects: AvailableProjectV2[] = [];
  let cursor: string | null = null;

  while (true) {
    const data: ProjectsV2OwnerResult = await githubGraphql<ProjectsV2OwnerResult>(
      token,
      query,
      { login: ownerLogin, cursor },
    );

    const connection: ProjectsV2Connection | undefined = (
      data.organization ?? data.user
    )?.projectsV2;
    if (!connection) break;

    for (const node of connection.nodes) {
      projects.push({
        nodeId: node.id,
        number: node.number,
        title: node.title,
        ownerType,
        ownerLogin,
        url: node.url,
        shortDescription: node.shortDescription,
        closed: node.closed,
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (!cursor) break;
  }

  return projects;
}

// ============================================================================
// Project Status field (single-select) — from GitHub
// ============================================================================

interface StatusFieldResult {
  node: {
    field: {
      id: string;
      name: string;
      options: { id: string; name: string }[];
    } | null;
  } | null;
}

const STATUS_FIELD_QUERY = /* GraphQL */ `
  query ($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
`;

/**
 * Read the "Status" single-select field of a Project (v2) and its options.
 * Returns nulls/empty options when the Project has no Status field.
 */
export async function getProjectStatusFields(
  token: string,
  projectNodeId: string,
): Promise<ProjectV2StatusFieldInfo> {
  const data = await githubGraphql<StatusFieldResult>(token, STATUS_FIELD_QUERY, {
    id: projectNodeId,
  });

  const field = data.node?.field ?? null;
  if (!field) {
    return { fieldId: null, fieldName: null, options: [] };
  }

  return {
    fieldId: field.id,
    fieldName: field.name,
    options: field.options.map((o) => ({ id: o.id, name: o.name })),
  };
}

// ============================================================================
// Project Links (DB)
// ============================================================================

/**
 * List project links for a workspace, optionally filtered by WeldFlow project.
 * Cursor pagination (limit + 1 fetch).
 */
export async function listLinkedProjects(
  db: Database,
  workspaceId: string,
  options: { projectId?: string; cursor?: string; limit?: number } = {},
): Promise<{
  data: (typeof githubProjectLinks.$inferSelect)[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}> {
  const limit = options.limit ?? 50;
  const conditions = [
    eq(githubProjectLinks.workspaceId, workspaceId),
    isNull(githubProjectLinks.deletedAt),
  ];

  if (options.projectId) {
    conditions.push(eq(githubProjectLinks.projectId, options.projectId));
  }

  const rows = await db
    .select()
    .from(githubProjectLinks)
    .where(and(...conditions))
    .orderBy(desc(githubProjectLinks.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  const totalCount = data.length + (hasMore ? 1 : 0);

  return { data, hasMore, cursor, totalCount };
}

/**
 * Get a single project link by ID, scoped to workspace.
 */
export async function getLinkedProject(
  db: Database,
  workspaceId: string,
  linkId: string,
) {
  const [row] = await db
    .select()
    .from(githubProjectLinks)
    .where(
      and(
        eq(githubProjectLinks.id, linkId),
        eq(githubProjectLinks.workspaceId, workspaceId),
        isNull(githubProjectLinks.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Link a GitHub Project (v2) to a WeldFlow project.
 * Both (projectId) and (connectionId, projectV2NodeId) are unique — DB enforces.
 */
export async function linkProject(
  db: Database,
  workspaceId: string,
  connectionId: string,
  input: CreateProjectLinkInput,
  userId: string,
): Promise<typeof githubProjectLinks.$inferSelect> {
  const now = new Date();

  const values = {
    connectionId,
    projectId: input.projectId,
    projectV2NodeId: input.projectV2NodeId,
    projectV2Number: input.projectV2Number,
    projectTitle: input.projectTitle ?? null,
    ownerType: input.ownerType,
    ownerLogin: input.ownerLogin,
    repoId: input.repoId ?? null,
    repoFullName: input.repoFullName ?? null,
    statusFieldId: input.statusFieldId ?? null,
    statusOptionMap: input.statusOptionMap ?? [],
    syncIssues: input.syncIssues ?? true,
    syncDirection: input.syncDirection ?? 'bidirectional',
  } as const;

  // The unique indexes on (project_id) and (connection_id, project_v2_node_id)
  // are NOT partial, so a previously-unlinked (soft-deleted) row still occupies
  // them. Revive/replace such a row instead of inserting a duplicate.
  const [existing] = await db
    .select({ id: githubProjectLinks.id })
    .from(githubProjectLinks)
    .where(
      and(
        eq(githubProjectLinks.workspaceId, workspaceId),
        eq(githubProjectLinks.projectId, input.projectId),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(githubProjectLinks)
      .set({ ...values, deletedAt: null, updatedAt: now })
      .where(eq(githubProjectLinks.id, existing.id))
      .returning();
    console.log(
      `[GitHub] User ${userId} re-linked Project #${input.projectV2Number} (${input.ownerLogin}) to project ${input.projectId} in workspace ${workspaceId}`,
    );
    return updated;
  }

  const [row] = await db
    .insert(githubProjectLinks)
    .values({ id: generateId('ghpl'), workspaceId, ...values, createdAt: now, updatedAt: now })
    .returning();

  console.log(
    `[GitHub] User ${userId} linked Project #${input.projectV2Number} (${input.ownerLogin}) to project ${input.projectId} in workspace ${workspaceId}`,
  );

  return row;
}

/**
 * Update sync settings / status mapping for a project link.
 */
export async function updateProjectLink(
  db: Database,
  workspaceId: string,
  linkId: string,
  input: UpdateProjectLinkInput,
): Promise<typeof githubProjectLinks.$inferSelect | null> {
  const updates: Partial<typeof githubProjectLinks.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.projectTitle !== undefined) updates.projectTitle = input.projectTitle;
  if (input.statusFieldId !== undefined) updates.statusFieldId = input.statusFieldId;
  if (input.statusOptionMap !== undefined) updates.statusOptionMap = input.statusOptionMap;
  if (input.syncDirection !== undefined) updates.syncDirection = input.syncDirection;
  if (input.syncIssues !== undefined) updates.syncIssues = input.syncIssues;

  const [updated] = await db
    .update(githubProjectLinks)
    .set(updates)
    .where(
      and(
        eq(githubProjectLinks.id, linkId),
        eq(githubProjectLinks.workspaceId, workspaceId),
        isNull(githubProjectLinks.deletedAt),
      ),
    )
    .returning();

  return updated ?? null;
}

/**
 * Soft-delete a project link.
 */
export async function unlinkProject(
  db: Database,
  workspaceId: string,
  linkId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(githubProjectLinks)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(githubProjectLinks.id, linkId),
        eq(githubProjectLinks.workspaceId, workspaceId),
        isNull(githubProjectLinks.deletedAt),
      ),
    )
    .returning({ id: githubProjectLinks.id });

  return result.length > 0;
}

// ============================================================================
// Serializer (DB row → API shape)
// ============================================================================

export function serializeProjectLink(row: typeof githubProjectLinks.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    projectId: row.projectId,
    projectV2NodeId: row.projectV2NodeId,
    projectV2Number: row.projectV2Number,
    projectTitle: row.projectTitle,
    ownerType: row.ownerType,
    ownerLogin: row.ownerLogin,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    statusFieldId: row.statusFieldId,
    statusOptionMap: row.statusOptionMap ?? [],
    syncIssues: row.syncIssues,
    syncDirection: row.syncDirection,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastError: row.lastError,
    syncCursor: row.syncCursor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
