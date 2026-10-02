/**
 * GithubProjectOutboundSyncWorkflow — Cloudflare Workflow (integration-webhook-worker)
 *
 * Pushes a WeldFlow task mutation to its linked GitHub Project (v2) item.
 *   create  — create issue (REST) → add to Project → set Status → write sync-map
 *   update  — update issue title/body (GraphQL, by node id)
 *   status  — set the Project item's Status single-select to the mapped option
 *   delete  — close the issue as NOT_PLANNED
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getTenantDbForWorkspace, schema } from '../db';
import { getInstallationToken } from '../github/auth';
import {
  createIssue,
  updateIssueFields,
  closeIssue,
  reopenIssue,
  addIssueToProject,
  updateProjectItemStatus,
  statusOptionForStageId,
  type StatusOptionMapping,
} from '../github/projects';
import { generateId } from '../lib/id';

export interface GithubProjectOutboundSyncParams {
  workspaceId: string;
  taskId: string;
  kind: 'create' | 'update' | 'status' | 'delete';
  projectLinkId?: string;
}

async function tokenFor(env: Env, installationId: number): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');
  }
  return getInstallationToken(appId, privateKey, installationId);
}

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type OutboundKind = GithubProjectOutboundSyncParams['kind'];

interface TaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  stageId: string | null;
  status: string;
  labels: string[] | null;
}

interface LinkSnapshot {
  id: string;
  projectV2NodeId: string;
  repoFullName: string | null;
  statusFieldId: string | null;
  statusOptionMap: StatusOptionMapping[] | null;
}

interface SyncMapSnapshot {
  id: string;
  issueNodeId: string | null;
  issueNumber: number;
  projectItemNodeId: string;
}

interface PushResult {
  issueNumber?: number;
  issueNodeId?: string;
  projectItemNodeId?: string;
  issueUpdatedAt?: string;
}

/**
 * Pick the project link a task syncs through: the existing sync-map link, else
 * (for `create` only) the explicit param link, else the task project's link.
 */
async function resolveLinkId(
  db: TenantDb,
  task: { projectId: string | null },
  syncMapRow: { projectLinkId: string } | undefined,
  kind: OutboundKind,
  paramLinkId: string | undefined,
): Promise<string | null> {
  if (syncMapRow) return syncMapRow.projectLinkId;
  if (kind !== 'create') return null;
  if (paramLinkId) return paramLinkId;
  if (!task.projectId) return null;

  const [byProject] = await db
    .select({ id: schema.githubProjectLinks.id })
    .from(schema.githubProjectLinks)
    .where(
      and(
        eq(schema.githubProjectLinks.projectId, task.projectId),
        isNull(schema.githubProjectLinks.deletedAt),
      ),
    )
    .limit(1);
  return byProject?.id ?? null;
}

/**
 * Status→stage fallback: tasks may have a null stageId and only carry
 * `status`; map task.status → stageId via the project's pipeline stages.
 */
async function loadStatusToStageId(db: TenantDb, projectId: string): Promise<Record<string, string>> {
  const stageRows = await db
    .select({
      id: schema.projectPipelineStages.id,
      systemStatus: schema.projectPipelineStages.systemStatus,
      position: schema.projectPipelineStages.position,
    })
    .from(schema.projectPipelineStages)
    .where(eq(schema.projectPipelineStages.projectId, projectId));
  const statusToStageId: Record<string, string> = {};
  for (const s of [...stageRows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (s.systemStatus && !(s.systemStatus in statusToStageId)) {
      statusToStageId[s.systemStatus] = s.id;
    }
  }
  return statusToStageId;
}

/** Set the Project item's Status column when a mapping exists for the stage. */
async function applyMappedStatus(
  token: string,
  link: LinkSnapshot,
  projectItemNodeId: string,
  effectiveStageId: string | null,
): Promise<void> {
  const optionId = statusOptionForStageId(link.statusOptionMap, effectiveStageId);
  if (optionId && link.statusFieldId) {
    await updateProjectItemStatus(token, link.projectV2NodeId, projectItemNodeId, link.statusFieldId, optionId);
  }
}

async function pushCreate(
  token: string,
  task: TaskSnapshot,
  link: LinkSnapshot,
  effectiveStageId: string | null,
): Promise<PushResult | null> {
  if (!link.repoFullName) {
    console.log(`[GithubProjectOutbound] Link ${link.id} has no repo — cannot create issue`);
    return null;
  }
  const issue = await createIssue(token, link.repoFullName, {
    title: task.title,
    body: task.description,
    labels: task.labels ?? undefined,
  });
  const itemNodeId = await addIssueToProject(token, link.projectV2NodeId, issue.node_id);
  await applyMappedStatus(token, link, itemNodeId, effectiveStageId);

  return {
    issueNumber: issue.number,
    issueNodeId: issue.node_id,
    projectItemNodeId: itemNodeId,
    issueUpdatedAt: issue.updated_at,
  };
}

async function pushUpdate(token: string, task: TaskSnapshot, map: SyncMapSnapshot): Promise<PushResult | null> {
  if (!map.issueNodeId) {
    console.log(`[GithubProjectOutbound] No issueNodeId for task ${task.id} — skipping update`);
    return null;
  }
  const updatedAt = await updateIssueFields(token, map.issueNodeId, {
    title: task.title,
    body: task.description,
  });
  return { issueUpdatedAt: updatedAt };
}

/** Mirror the task's open/closed state onto the issue. */
async function mirrorIssueState(token: string, issueNodeId: string, taskStatus: string): Promise<string> {
  if (taskStatus === 'done') return closeIssue(token, issueNodeId, 'COMPLETED');
  if (taskStatus === 'cancelled') return closeIssue(token, issueNodeId, 'NOT_PLANNED');
  return reopenIssue(token, issueNodeId);
}

async function pushStatus(
  token: string,
  task: TaskSnapshot,
  link: LinkSnapshot,
  map: SyncMapSnapshot,
  effectiveStageId: string | null,
): Promise<PushResult> {
  // 1) Set the mapped Status column (if we have a mapping for this stage).
  await applyMappedStatus(token, link, map.projectItemNodeId, effectiveStageId);
  // 2) Mirror open/closed state onto the issue (best-effort; idempotent).
  let issueUpdatedAt = new Date().toISOString();
  if (map.issueNodeId) {
    try {
      issueUpdatedAt = await mirrorIssueState(token, map.issueNodeId, task.status);
    } catch (e) {
      console.log(
        `[GithubProjectOutbound] issue state change skipped for task ${task.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { issueUpdatedAt };
}

async function pushDelete(token: string, map: SyncMapSnapshot): Promise<PushResult | null> {
  if (!map.issueNodeId) return null;
  const updatedAt = await closeIssue(token, map.issueNodeId, 'NOT_PLANNED');
  return { issueUpdatedAt: updatedAt };
}

export class GithubProjectOutboundSyncWorkflow extends WorkflowEntrypoint<
  Env,
  GithubProjectOutboundSyncParams
> {
  async run(event: WorkflowEvent<GithubProjectOutboundSyncParams>, step: WorkflowStep) {
    const { workspaceId, taskId, kind, projectLinkId: paramLinkId } = event.payload;

    const ctx = await step.do(
      'load-task',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);

        const [task] = await db
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, taskId), isNull(schema.tasks.deletedAt)))
          .limit(1);

        if (!task) throw new Error(`Task ${taskId} not found`);

        const [syncMapRow] = await db
          .select()
          .from(schema.githubIssueSyncMap)
          .where(eq(schema.githubIssueSyncMap.taskId, taskId))
          .limit(1);

        const linkId = await resolveLinkId(db, task, syncMapRow, kind, paramLinkId);

        if (!linkId) return null;

        const [link] = await db
          .select()
          .from(schema.githubProjectLinks)
          .where(
            and(
              eq(schema.githubProjectLinks.id, linkId),
              eq(schema.githubProjectLinks.workspaceId, workspaceId),
              isNull(schema.githubProjectLinks.deletedAt),
            ),
          )
          .limit(1);

        if (!link) throw new Error(`Project link ${linkId} not found`);

        if (link.syncDirection === 'inbound') {
          console.log(`[GithubProjectOutbound] syncDirection=inbound for link ${link.id} — no-op`);
          return null;
        }

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

        if (!conn) throw new Error(`Connection for link ${link.id} not found`);
        if (conn.status !== 'active') throw new Error(`Connection ${conn.id} is not active`);

        const statusToStageId = await loadStatusToStageId(db, link.projectId);

        return {
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            stageId: task.stageId,
            status: task.status,
            labels: (task.labels as string[] | null) ?? null,
          },
          link: {
            id: link.id,
            projectV2NodeId: link.projectV2NodeId,
            repoFullName: link.repoFullName,
            statusFieldId: link.statusFieldId,
            statusOptionMap: (link.statusOptionMap ?? null) as StatusOptionMapping[] | null,
          },
          installationId: conn.installationId,
          statusToStageId,
          syncMap: syncMapRow
            ? {
                id: syncMapRow.id,
                issueNodeId: syncMapRow.issueNodeId,
                issueNumber: syncMapRow.issueNumber,
                projectItemNodeId: syncMapRow.projectItemNodeId,
              }
            : null,
        };
      },
    );

    if (!ctx) {
      console.log(`[GithubProjectOutbound] No-op for task ${taskId} (kind=${kind})`);
      return;
    }

    const { task, link, installationId, syncMap, statusToStageId } = ctx;
    // Resolve the task's effective stage (fall back to status→stage when stageId is null).
    const effectiveStageId = task.stageId ?? statusToStageId[task.status] ?? null;

    if (kind !== 'create' && !syncMap) {
      console.log(`[GithubProjectOutbound] Task ${taskId} not mapped — skipping kind=${kind}`);
      return;
    }

    const result = await step.do(
      'push-to-github',
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
      async () => {
        const token = await tokenFor(this.env, installationId);

        if (kind === 'create') return pushCreate(token, task, link, effectiveStageId);

        const map = syncMap!;

        if (kind === 'update') return pushUpdate(token, task, map);
        if (kind === 'status') return pushStatus(token, task, link, map, effectiveStageId);
        if (kind === 'delete') return pushDelete(token, map);

        throw new Error(`Unknown kind: ${kind}`);
      },
    );

    if (!result) return;

    await step.do(
      'update-sync-map',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);
        const now = new Date();
        const issueUpdatedAt = result.issueUpdatedAt ? new Date(result.issueUpdatedAt) : now;

        if (kind === 'create') {
          await db
            .update(schema.tasks)
            .set({ githubIssueNumber: result.issueNumber ?? null, updatedAt: now })
            .where(eq(schema.tasks.id, task.id));

          await db.insert(schema.githubIssueSyncMap).values({
            id: generateId('ghsm'),
            workspaceId,
            projectLinkId: link.id,
            taskId: task.id,
            projectItemNodeId: result.projectItemNodeId!,
            issueNodeId: result.issueNodeId ?? null,
            issueNumber: result.issueNumber!,
            lastSyncedTaskUpdatedAt: now,
            lastSyncedIssueUpdatedAt: issueUpdatedAt,
            lastWriterSide: 'task',
            createdAt: now,
            updatedAt: now,
          });
          return;
        }

        if (syncMap) {
          await db
            .update(schema.githubIssueSyncMap)
            .set({
              lastSyncedTaskUpdatedAt: now,
              lastSyncedIssueUpdatedAt: issueUpdatedAt,
              lastWriterSide: 'task',
              updatedAt: now,
            })
            .where(eq(schema.githubIssueSyncMap.id, syncMap.id));
        }
      },
    );
  }
}
