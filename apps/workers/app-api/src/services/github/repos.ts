/**
 * GitHub Repository Service
 *
 * Manages the lifecycle of linked repositories: listing available repos
 * from GitHub, linking repos to projects, and CRUD on repo links.
 *
 * All DB queries are scoped by workspaceId.
 */

import { eq, and, isNull, desc } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { AvailableRepo, CreateRepoLinkInput, UpdateRepoLinkInput } from '@weldsuite/core-api-client/schemas/github';

const { githubRepoLinks } = schema;

// ============================================================================
// Available Repos (from GitHub API)
// ============================================================================

interface GithubApiRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

interface GithubReposResponse {
  repositories: GithubApiRepo[];
  total_count: number;
}

/**
 * List all repositories accessible to a GitHub App installation.
 * Paginates through all pages and returns the full list.
 *
 * @param installationToken - Short-lived GitHub installation access token
 */
export async function listAvailableRepos(
  installationToken: string,
): Promise<AvailableRepo[]> {
  const repos: AvailableRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const resp = await fetch(
      `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${installationToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'WeldSuite-Core-API',
        },
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Failed to list installation repositories (${resp.status}): ${body}`);
    }

    // Respect rate limit headers — log a warning if close to limit
    const remaining = Number(resp.headers.get('X-RateLimit-Remaining') ?? '999');
    if (remaining < 10) {
      console.warn('[GitHub] Rate limit approaching:', remaining, 'requests remaining');
    }

    const data = (await resp.json()) as GithubReposResponse;
    for (const r of data.repositories) {
      repos.push({
        id: r.id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      });
    }

    if (repos.length >= data.total_count || data.repositories.length < perPage) break;
    page++;
  }

  return repos;
}

// ============================================================================
// Linked Repos (DB)
// ============================================================================

/**
 * List linked repositories for a workspace, optionally filtered by project.
 * Uses cursor pagination (limit + 1 fetch).
 */
export async function listLinkedRepos(
  db: Database,
  workspaceId: string,
  options: {
    projectId?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{
  data: typeof githubRepoLinks.$inferSelect[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}> {
  const limit = options.limit ?? 50;
  const conditions = [
    eq(githubRepoLinks.workspaceId, workspaceId),
    isNull(githubRepoLinks.deletedAt),
  ];

  if (options.projectId) {
    conditions.push(eq(githubRepoLinks.projectId, options.projectId));
  }

  const rows = await db
    .select()
    .from(githubRepoLinks)
    .where(and(...conditions))
    .orderBy(desc(githubRepoLinks.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

  // Count for pagination metadata
  const totalCount = data.length + (hasMore ? 1 : 0);

  return { data, hasMore, cursor, totalCount };
}

/**
 * Get a single linked repo by ID, scoped to workspace.
 */
export async function getLinkedRepo(
  db: Database,
  workspaceId: string,
  linkId: string,
) {
  const [row] = await db
    .select()
    .from(githubRepoLinks)
    .where(
      and(
        eq(githubRepoLinks.id, linkId),
        eq(githubRepoLinks.workspaceId, workspaceId),
        isNull(githubRepoLinks.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Link a GitHub repository to a WeldFlow project.
 * The (connectionId, repoId) pair must be unique — DB has a unique index.
 */
export async function linkRepo(
  db: Database,
  workspaceId: string,
  connectionId: string,
  input: CreateRepoLinkInput,
  userId: string,
): Promise<typeof githubRepoLinks.$inferSelect> {
  const id = generateId('ghrl');
  const now = new Date();

  const [row] = await db
    .insert(githubRepoLinks)
    .values({
      id,
      workspaceId,
      connectionId,
      projectId: input.projectId ?? null,
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      defaultBranch: input.defaultBranch ?? null,
      syncIssues: input.syncIssues ?? true,
      syncDirection: input.syncDirection ?? 'bidirectional',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  console.log(`[GitHub] User ${userId} linked repo ${input.repoFullName} in workspace ${workspaceId}`);

  return row;
}

/**
 * Update sync settings for a linked repository.
 */
export async function updateRepoLink(
  db: Database,
  workspaceId: string,
  linkId: string,
  input: UpdateRepoLinkInput,
): Promise<typeof githubRepoLinks.$inferSelect | null> {
  const updates: Partial<typeof githubRepoLinks.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.projectId !== undefined) updates.projectId = input.projectId;
  if (input.defaultBranch !== undefined) updates.defaultBranch = input.defaultBranch;
  if (input.syncDirection !== undefined) updates.syncDirection = input.syncDirection;
  if (input.syncIssues !== undefined) updates.syncIssues = input.syncIssues;

  const [updated] = await db
    .update(githubRepoLinks)
    .set(updates)
    .where(
      and(
        eq(githubRepoLinks.id, linkId),
        eq(githubRepoLinks.workspaceId, workspaceId),
        isNull(githubRepoLinks.deletedAt),
      ),
    )
    .returning();

  return updated ?? null;
}

/**
 * Soft-delete a repo link.
 */
export async function unlinkRepo(
  db: Database,
  workspaceId: string,
  linkId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(githubRepoLinks)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(githubRepoLinks.id, linkId),
        eq(githubRepoLinks.workspaceId, workspaceId),
        isNull(githubRepoLinks.deletedAt),
      ),
    )
    .returning({ id: githubRepoLinks.id });

  return result.length > 0;
}

/**
 * Remove all repo links for a given set of GitHub repo IDs.
 * Called when an installation_repositories webhook fires with removals.
 */
export async function removeRepoLinksByRepoIds(
  db: Database,
  workspaceId: string,
  connectionId: string,
  repoIds: number[],
): Promise<void> {
  if (repoIds.length === 0) return;

  const now = new Date();
  for (const repoId of repoIds) {
    await db
      .update(githubRepoLinks)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(githubRepoLinks.workspaceId, workspaceId),
          eq(githubRepoLinks.connectionId, connectionId),
          eq(githubRepoLinks.repoId, repoId),
          isNull(githubRepoLinks.deletedAt),
        ),
      );
  }
}
