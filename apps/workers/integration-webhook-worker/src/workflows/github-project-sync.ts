/**
 * GithubProjectSyncWorkflow — Cloudflare Workflow (hosted in integration-webhook-worker)
 *
 * Inbound sync of one GitHub Project (v2) link: walks the Project's items
 * (issues) and upserts them as WeldFlow tasks, mapping the Project "Status"
 * single-select option to a WeldFlow stage. Backs both the automatic sync
 * (webhook) and the manual "Sync now" trigger (app-api).
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { getInstallationToken } from '../github/auth';
import {
  fetchProjectItemsPage,
  createIssue,
  addIssueToProject,
  updateProjectItemStatus,
  stageIdForStatusOption,
  statusOptionForStageId,
  taskStatusFromIssueState,
  type ProjectItemIssue,
  type StatusOptionMapping,
} from '../github/projects';
import { generateId } from '../lib/id';

export interface GithubProjectSyncParams {
  workspaceId: string;
  projectLinkId: string;
  /** When true, only pull GitHub→WeldFlow (skip outbound reconcile). Set by the
   *  webhook path so a GitHub-originated change never writes back to GitHub and
   *  re-triggers itself. */
  inboundOnly?: boolean;
}

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type SyncMapRow = typeof schema.githubIssueSyncMap.$inferSelect;

interface LinkData {
  installationId: number;
  projectV2NodeId: string;
  projectId: string;
  syncDirection: string;
  syncIssues: boolean;
  statusOptionMap: StatusOptionMapping[] | null;
  repoFullName: string | null;
  statusFieldId: string | null;
}

/** What to do with a task that is already mapped to a Project item. */
type ExistingItemDecision = 'apply-issue' | 'keep-task' | 'skip';

/**
 * Decide how to reconcile an already-mapped task with its GitHub item using the
 * last-synced timestamps. Conflicts (both sides changed) go to the newer side.
 */
function decideExistingItem(
  taskUpdatedAt: Date,
  existing: SyncMapRow,
  issueUpdatedAt: Date,
  item: ProjectItemIssue,
): ExistingItemDecision {
  const lastSyncedTask = existing.lastSyncedTaskUpdatedAt;
  const lastSyncedIssue = existing.lastSyncedIssueUpdatedAt;
  const taskChangedSinceSync = lastSyncedTask ? taskUpdatedAt > lastSyncedTask : false;
  const issueChangedSinceSync = lastSyncedIssue ? issueUpdatedAt > lastSyncedIssue : true;

  if (!taskChangedSinceSync) return 'apply-issue';
  if (!issueChangedSinceSync) return 'skip';

  const taskWins = taskUpdatedAt >= issueUpdatedAt;
  console.warn(
    `[GithubProjectSync] CONFLICT on item ${item.itemNodeId} (issue #${item.number}). Winner: ${taskWins ? 'task' : 'issue'}.`,
  );
  return taskWins ? 'keep-task' : 'apply-issue';
}

async function updateMappedTask(
  db: TenantDb,
  existing: SyncMapRow,
  item: ProjectItemIssue,
  status: ReturnType<typeof taskStatusFromIssueState>,
  stageId: string | null | undefined,
  issueUpdatedAt: Date,
): Promise<void> {
  const now = new Date();
  const taskUpdate: Partial<typeof schema.tasks.$inferInsert> = {
    title: item.title,
    description: item.body ?? null,
    status,
    labels: item.labels,
    updatedAt: now,
  };
  if (stageId) taskUpdate.stageId = stageId;

  await db.update(schema.tasks).set(taskUpdate).where(eq(schema.tasks.id, existing.taskId));

  await db
    .update(schema.githubIssueSyncMap)
    .set({
      lastSyncedIssueUpdatedAt: issueUpdatedAt,
      lastSyncedTaskUpdatedAt: now,
      issueNodeId: item.issueNodeId,
      issueNumber: item.number,
      repoId: item.repoId,
      lastWriterSide: 'issue',
      updatedAt: now,
    })
    .where(eq(schema.githubIssueSyncMap.id, existing.id));
}

async function upsertItemAsTask(
  db: TenantDb,
  workspaceId: string,
  projectLinkId: string,
  projectId: string,
  statusOptionMap: StatusOptionMapping[] | null,
  item: ProjectItemIssue,
): Promise<void> {
  const issueUpdatedAt = new Date(item.updatedAt);
  const status = taskStatusFromIssueState(item.state, item.stateReason);
  const stageId = stageIdForStatusOption(statusOptionMap, item.statusOptionId);

  const [existing] = await db
    .select()
    .from(schema.githubIssueSyncMap)
    .where(
      and(
        eq(schema.githubIssueSyncMap.projectLinkId, projectLinkId),
        eq(schema.githubIssueSyncMap.projectItemNodeId, item.itemNodeId),
      ),
    )
    .limit(1);

  if (existing) {
    const [task] = await db
      .select({ id: schema.tasks.id, updatedAt: schema.tasks.updatedAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, existing.taskId))
      .limit(1);

    if (!task) {
      await db.delete(schema.githubIssueSyncMap).where(eq(schema.githubIssueSyncMap.id, existing.id));
      return;
    }

    const decision = decideExistingItem(task.updatedAt, existing, issueUpdatedAt, item);
    if (decision === 'keep-task') {
      await db
        .update(schema.githubIssueSyncMap)
        .set({
          lastSyncedTaskUpdatedAt: task.updatedAt,
          lastSyncedIssueUpdatedAt: issueUpdatedAt,
          lastWriterSide: 'task',
          updatedAt: new Date(),
        })
        .where(eq(schema.githubIssueSyncMap.id, existing.id));
      return;
    }
    if (decision === 'skip') return;

    await updateMappedTask(db, existing, item, status, stageId, issueUpdatedAt);
    return;
  }

  const taskId = generateId('tsk');
  const syncMapId = generateId('ghsm');
  const now = new Date();

  await db.insert(schema.tasks).values({
    id: taskId,
    title: item.title,
    description: item.body ?? null,
    status,
    ...(stageId ? { stageId } : {}),
    priority: 'medium',
    progress: '0',
    projectId,
    labels: item.labels,
    githubIssueNumber: item.number,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.githubIssueSyncMap).values({
    id: syncMapId,
    workspaceId,
    projectLinkId,
    taskId,
    projectItemNodeId: item.itemNodeId,
    issueNodeId: item.issueNodeId,
    issueNumber: item.number,
    repoId: item.repoId,
    lastSyncedTaskUpdatedAt: now,
    lastSyncedIssueUpdatedAt: issueUpdatedAt,
    lastWriterSide: 'issue',
    createdAt: now,
    updatedAt: now,
  });
}

async function loadLinkData(env: Env, workspaceId: string, projectLinkId: string): Promise<LinkData> {
  const db = await getTenantDbForWorkspace(env, workspaceId);

  const [link] = await db
    .select()
    .from(schema.githubProjectLinks)
    .where(
      and(
        eq(schema.githubProjectLinks.id, projectLinkId),
        eq(schema.githubProjectLinks.workspaceId, workspaceId),
        isNull(schema.githubProjectLinks.deletedAt),
      ),
    )
    .limit(1);

  if (!link) throw new Error(`Project link ${projectLinkId} not found`);

  const [conn] = await db
    .select()
    .from(schema.githubConnections)
    .where(
      and(
        eq(schema.githubConnections.id, link.connectionId),
        isNull(schema.githubConnections.deletedAt),
      ),
    )
    .limit(1);

  if (!conn) throw new Error(`Connection for project link ${projectLinkId} not found`);
  if (conn.status !== 'active') {
    throw new Error(`Connection ${conn.id} is not active (status: ${conn.status})`);
  }

  return {
    installationId: conn.installationId,
    projectV2NodeId: link.projectV2NodeId,
    projectId: link.projectId,
    syncDirection: link.syncDirection,
    syncIssues: link.syncIssues,
    statusOptionMap: (link.statusOptionMap ?? null) as StatusOptionMapping[] | null,
    repoFullName: link.repoFullName,
    statusFieldId: link.statusFieldId,
  };
}

async function acquireToken(env: Env, installationId: number): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');
  }
  return getInstallationToken(appId, privateKey, installationId);
}

async function applyItemsBatch(
  env: Env,
  workspaceId: string,
  projectLinkId: string,
  linkData: LinkData,
  items: ProjectItemIssue[],
): Promise<{ processed: number }> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  for (const item of items) {
    try {
      await upsertItemAsTask(db, workspaceId, projectLinkId, linkData.projectId, linkData.statusOptionMap, item);
    } catch (err) {
      console.error(`[GithubProjectSync] Failed to upsert item ${item.itemNodeId}:`, err);
    }
  }
  return { processed: items.length };
}

/**
 * Inbound: walk the Project's items page by page and upsert them as WeldFlow
 * tasks. Returns the item node ids seen (for pruning) and the processed count.
 */
async function pullProjectItems(
  env: Env,
  step: WorkflowStep,
  workspaceId: string,
  projectLinkId: string,
  linkData: LinkData,
  token: string,
): Promise<{ seenItemNodeIds: Set<string>; totalProcessed: number }> {
  let cursor: string | null = null;
  let page = 1;
  let totalProcessed = 0;
  const seenItemNodeIds = new Set<string>();

  while (true) {
    const pageResult = (await step.do(
      `page-${page}`,
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
      async () => {
        const { items, hasNextPage, endCursor } = await fetchProjectItemsPage(
          token,
          linkData.projectV2NodeId,
          cursor,
        );
        return { items, hasNextPage, endCursor };
      },
    )) as { items: ProjectItemIssue[]; hasNextPage: boolean; endCursor: string | null };

    for (const it of pageResult.items) seenItemNodeIds.add(it.itemNodeId);

    if (pageResult.items.length > 0) {
      await step.do(
        `apply-batch-${page}`,
        { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
        () => applyItemsBatch(env, workspaceId, projectLinkId, linkData, pageResult.items),
      );
      totalProcessed += pageResult.items.length;
    }

    if (!pageResult.hasNextPage || !pageResult.endCursor) break;
    cursor = pageResult.endCursor;
    page++;
  }

  return { seenItemNodeIds, totalProcessed };
}

/**
 * Self-heal: drop sync-map rows whose Project item no longer exists (issue
 * deleted / removed from the board). This lets the task be re-created on the
 * outbound pass. We do NOT clear task.githubIssueNumber — guard #2 still
 * blocks re-creating issues that were merely archived (number still set).
 */
async function pruneStaleMappings(
  env: Env,
  workspaceId: string,
  projectLinkId: string,
  seenItemNodeIds: Set<string>,
): Promise<{ pruned: number }> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const rows = await db
    .select({
      id: schema.githubIssueSyncMap.id,
      projectItemNodeId: schema.githubIssueSyncMap.projectItemNodeId,
    })
    .from(schema.githubIssueSyncMap)
    .where(eq(schema.githubIssueSyncMap.projectLinkId, projectLinkId));
  let pruned = 0;
  for (const r of rows) {
    if (!seenItemNodeIds.has(r.projectItemNodeId)) {
      await db.delete(schema.githubIssueSyncMap).where(eq(schema.githubIssueSyncMap.id, r.id));
      pruned++;
    }
  }
  if (pruned) {
    console.log(`[GithubProjectSync] Pruned ${pruned} stale mapping(s) for link ${projectLinkId}`);
  }
  return { pruned };
}

/**
 * Tasks may have a null stageId (they only carry `status`). Build a
 * status → stageId fallback from the project's pipeline stages (each stage has
 * a systemStatus), so the status→stage→option mapping resolves even when
 * stageId isn't set.
 */
async function loadStatusToStageMap(db: TenantDb, projectId: string): Promise<Map<string, string>> {
  const stageRows = await db
    .select({
      id: schema.projectPipelineStages.id,
      systemStatus: schema.projectPipelineStages.systemStatus,
      position: schema.projectPipelineStages.position,
    })
    .from(schema.projectPipelineStages)
    .where(eq(schema.projectPipelineStages.projectId, projectId));
  const statusToStageId = new Map<string, string>();
  for (const s of [...stageRows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (s.systemStatus && !statusToStageId.has(s.systemStatus)) {
      statusToStageId.set(s.systemStatus, s.id);
    }
  }
  return statusToStageId;
}

/** Shared inputs for the outbound reconcile of one link. */
interface OutboundReconcileContext {
  db: TenantDb;
  token: string;
  workspaceId: string;
  projectLinkId: string;
  linkData: LinkData;
  repoFullName: string;
}

/** Create the GitHub issue for a task, add it to the Project and record the mapping. */
async function createIssueForTask(
  rc: OutboundReconcileContext,
  task: typeof schema.tasks.$inferSelect,
  optionId: string | null,
): Promise<void> {
  const { db, token, workspaceId, projectLinkId, linkData, repoFullName } = rc;

  const issue = await createIssue(token, repoFullName, {
    title: task.title,
    body: task.description,
    labels: (task.labels as string[] | null) ?? undefined,
  });
  const itemNodeId = await addIssueToProject(token, linkData.projectV2NodeId, issue.node_id);
  if (optionId && linkData.statusFieldId) {
    await updateProjectItemStatus(token, linkData.projectV2NodeId, itemNodeId, linkData.statusFieldId, optionId);
  }

  const now = new Date();
  // 3) Claim the task immediately (set issue number) so any concurrent
  //    pass sees guard #1/#2 and won't create a second issue.
  await db
    .update(schema.tasks)
    .set({ githubIssueNumber: issue.number, updatedAt: now })
    .where(eq(schema.tasks.id, task.id));

  await db.insert(schema.githubIssueSyncMap).values({
    id: generateId('ghsm'),
    workspaceId,
    projectLinkId,
    taskId: task.id,
    projectItemNodeId: itemNodeId,
    issueNodeId: issue.node_id,
    issueNumber: issue.number,
    repoId: null,
    lastSyncedTaskUpdatedAt: now,
    lastSyncedIssueUpdatedAt: new Date(issue.updated_at),
    lastWriterSide: 'task',
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * True when the task must not get a new issue: it already records an issue
 * number (pushed before, any link), or a sync-map row exists for it under ANY
 * link (taskId is globally unique in the map) — authoritative "already pushed".
 */
async function isAlreadyPushed(db: TenantDb, task: typeof schema.tasks.$inferSelect): Promise<boolean> {
  // 1) Task already records an issue number.
  if (task.githubIssueNumber != null) return true;
  // 2) A sync-map row exists for this task.
  const [alreadyMapped] = await db
    .select({ id: schema.githubIssueSyncMap.id })
    .from(schema.githubIssueSyncMap)
    .where(eq(schema.githubIssueSyncMap.taskId, task.id))
    .limit(1);
  return !!alreadyMapped;
}

/** Reconcile one task: re-status it if already on the board, else create its issue. */
async function reconcileTask(
  rc: OutboundReconcileContext,
  task: typeof schema.tasks.$inferSelect,
  existingItem: string | undefined,
  statusToStageId: Map<string, string>,
): Promise<'pushed' | 'restatused' | 'none'> {
  const { db, token, linkData } = rc;
  const effectiveStageId = task.stageId ?? statusToStageId.get(task.status) ?? null;
  const optionId = statusOptionForStageId(linkData.statusOptionMap, effectiveStageId);

  // Already on the board → reconcile its Status, never create again.
  if (existingItem) {
    if (!optionId || !linkData.statusFieldId) return 'none';
    await updateProjectItemStatus(token, linkData.projectV2NodeId, existingItem, linkData.statusFieldId, optionId);
    return 'restatused';
  }

  // ── Anti-duplicate safeguards (any ONE prevents a 2nd issue) ──
  if (await isAlreadyPushed(db, task)) return 'none';

  await createIssueForTask(rc, task, optionId);
  return 'pushed';
}

/** Outbound reconcile: WeldFlow tasks → new GitHub issues in the Project. */
async function reconcileOutbound(
  env: Env,
  workspaceId: string,
  projectLinkId: string,
  linkData: LinkData,
  token: string,
  repoFullName: string,
): Promise<{ pushed: number; restatused: number }> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const rc: OutboundReconcileContext = { db, token, workspaceId, projectLinkId, linkData, repoFullName };

  const syncRows = await db
    .select({
      taskId: schema.githubIssueSyncMap.taskId,
      projectItemNodeId: schema.githubIssueSyncMap.projectItemNodeId,
    })
    .from(schema.githubIssueSyncMap)
    .where(eq(schema.githubIssueSyncMap.projectLinkId, projectLinkId));
  const itemByTask = new Map<string, string>(syncRows.map((r) => [r.taskId, r.projectItemNodeId]));

  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, linkData.projectId), isNull(schema.tasks.deletedAt)));

  const statusToStageId = await loadStatusToStageMap(db, linkData.projectId);

  let pushed = 0;
  let restatused = 0;
  for (const task of tasks) {
    try {
      const outcome = await reconcileTask(rc, task, itemByTask.get(task.id), statusToStageId);
      if (outcome === 'pushed') pushed++;
      else if (outcome === 'restatused') restatused++;
    } catch (err) {
      console.error(`[GithubProjectSync] Failed outbound for task ${task.id}:`, err);
    }
  }
  console.log(
    `[GithubProjectSync] Outbound reconcile for link ${projectLinkId}: created ${pushed}, restatused ${restatused}`,
  );
  return { pushed, restatused };
}

export class GithubProjectSyncWorkflow extends WorkflowEntrypoint<Env, GithubProjectSyncParams> {
  async run(event: WorkflowEvent<GithubProjectSyncParams>, step: WorkflowStep) {
    const { workspaceId, projectLinkId, inboundOnly } = event.payload;

    const linkData = await step.do(
      'load-link',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      () => loadLinkData(this.env, workspaceId, projectLinkId),
    );

    if (!linkData.syncIssues) {
      console.log(`[GithubProjectSync] syncIssues=false for link ${projectLinkId}, skipping`);
      return;
    }

    const token = await step.do(
      'acquire-token',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      () => acquireToken(this.env, linkData.installationId),
    );

    // ── Inbound: GitHub Project items → WeldFlow tasks ───────────────────────
    let totalProcessed = 0;

    if (linkData.syncDirection !== 'outbound') {
      const pulled = await pullProjectItems(this.env, step, workspaceId, projectLinkId, linkData, token);
      totalProcessed = pulled.totalProcessed;

      await step.do(
        'prune-stale-mappings',
        { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
        () => pruneStaleMappings(this.env, workspaceId, projectLinkId, pulled.seenItemNodeIds),
      );
    }

    // ── Outbound reconcile: WeldFlow tasks → new GitHub issues in the Project ─
    if (!inboundOnly && linkData.syncDirection !== 'inbound') {
      const repoFullName = linkData.repoFullName;
      if (!repoFullName) {
        console.log(
          `[GithubProjectSync] No target repo on link ${projectLinkId} — skipping outbound reconcile (link a repo to enable WeldFlow→GitHub).`,
        );
      } else {
        await step.do(
          'outbound-reconcile',
          { retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' } },
          () => reconcileOutbound(this.env, workspaceId, projectLinkId, linkData, token, repoFullName),
        );
      }
    }

    await step.do(
      'update-link',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);
        const now = new Date();
        await db
          .update(schema.githubProjectLinks)
          .set({ lastSyncedAt: now, lastError: null, syncCursor: null, updatedAt: now })
          .where(eq(schema.githubProjectLinks.id, projectLinkId));
        console.log(`[GithubProjectSync] Completed sync for link ${projectLinkId}. Processed ${totalProcessed} items.`);
      },
    );
  }
}
