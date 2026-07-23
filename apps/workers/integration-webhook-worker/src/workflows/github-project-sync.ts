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

async function upsertItemAsTask(
  db: Awaited<ReturnType<typeof getTenantDbForWorkspace>>,
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

    const lastSyncedTask = existing.lastSyncedTaskUpdatedAt;
    const lastSyncedIssue = existing.lastSyncedIssueUpdatedAt;
    const taskChangedSinceSync = lastSyncedTask ? task.updatedAt > lastSyncedTask : false;
    const issueChangedSinceSync = lastSyncedIssue ? issueUpdatedAt > lastSyncedIssue : true;

    if (taskChangedSinceSync && issueChangedSinceSync) {
      const taskWins = task.updatedAt >= issueUpdatedAt;
      console.warn(
        `[GithubProjectSync] CONFLICT on item ${item.itemNodeId} (issue #${item.number}). Winner: ${taskWins ? 'task' : 'issue'}.`,
      );
      if (taskWins) {
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
    } else if (taskChangedSinceSync && !issueChangedSinceSync) {
      return;
    }

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

export class GithubProjectSyncWorkflow extends WorkflowEntrypoint<Env, GithubProjectSyncParams> {
  async run(event: WorkflowEvent<GithubProjectSyncParams>, step: WorkflowStep) {
    const { workspaceId, projectLinkId, inboundOnly } = event.payload;

    const linkData = await step.do(
      'load-link',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);

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
      },
    );

    if (!linkData.syncIssues) {
      console.log(`[GithubProjectSync] syncIssues=false for link ${projectLinkId}, skipping`);
      return;
    }

    const token = await step.do(
      'acquire-token',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const appId = this.env.GITHUB_APP_ID;
        const privateKey = this.env.GITHUB_APP_PRIVATE_KEY;
        if (!appId || !privateKey) {
          throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');
        }
        return getInstallationToken(appId, privateKey, linkData.installationId);
      },
    );

    // ── Inbound: GitHub Project items → WeldFlow tasks ───────────────────────
    let cursor: string | null = null;
    let page = 1;
    let totalProcessed = 0;
    const seenItemNodeIds = new Set<string>();

    if (linkData.syncDirection !== 'outbound') {
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
            async () => {
              const db = await getTenantDbForWorkspace(this.env, workspaceId);
              for (const item of pageResult.items) {
                try {
                  await upsertItemAsTask(
                    db,
                    workspaceId,
                    projectLinkId,
                    linkData.projectId,
                    linkData.statusOptionMap,
                    item,
                  );
                } catch (err) {
                  console.error(`[GithubProjectSync] Failed to upsert item ${item.itemNodeId}:`, err);
                }
              }
              return { processed: pageResult.items.length };
            },
          );
          totalProcessed += pageResult.items.length;
        }

        if (!pageResult.hasNextPage || !pageResult.endCursor) break;
        cursor = pageResult.endCursor;
        page++;
      }

      // Self-heal: drop sync-map rows whose Project item no longer exists (issue
      // deleted / removed from the board). This lets the task be re-created on the
      // outbound pass. We do NOT clear task.githubIssueNumber — guard #2 still
      // blocks re-creating issues that were merely archived (number still set).
      await step.do(
        'prune-stale-mappings',
        { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
        async () => {
          const db = await getTenantDbForWorkspace(this.env, workspaceId);
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
              await db
                .delete(schema.githubIssueSyncMap)
                .where(eq(schema.githubIssueSyncMap.id, r.id));
              pruned++;
            }
          }
          if (pruned) {
            console.log(`[GithubProjectSync] Pruned ${pruned} stale mapping(s) for link ${projectLinkId}`);
          }
          return { pruned };
        },
      );
    }

    // ── Outbound reconcile: WeldFlow tasks → new GitHub issues in the Project ─
    if (!inboundOnly && linkData.syncDirection !== 'inbound') {
      if (!linkData.repoFullName) {
        console.log(
          `[GithubProjectSync] No target repo on link ${projectLinkId} — skipping outbound reconcile (link a repo to enable WeldFlow→GitHub).`,
        );
      } else {
        await step.do(
          'outbound-reconcile',
          { retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' } },
          async () => {
            const db = await getTenantDbForWorkspace(this.env, workspaceId);
            const repoFullName = linkData.repoFullName as string;

            const syncRows = await db
              .select({
                taskId: schema.githubIssueSyncMap.taskId,
                projectItemNodeId: schema.githubIssueSyncMap.projectItemNodeId,
              })
              .from(schema.githubIssueSyncMap)
              .where(eq(schema.githubIssueSyncMap.projectLinkId, projectLinkId));
            const itemByTask = new Map<string, string>(
              syncRows.map((r) => [r.taskId, r.projectItemNodeId]),
            );

            const tasks = await db
              .select()
              .from(schema.tasks)
              .where(and(eq(schema.tasks.projectId, linkData.projectId), isNull(schema.tasks.deletedAt)));

            // Tasks may have a null stageId (they only carry `status`). Build a
            // status → stageId fallback from the project's pipeline stages
            // (each stage has a systemStatus), so the status→stage→option mapping
            // resolves even when stageId isn't set.
            const stageRows = await db
              .select({
                id: schema.projectPipelineStages.id,
                systemStatus: schema.projectPipelineStages.systemStatus,
                position: schema.projectPipelineStages.position,
              })
              .from(schema.projectPipelineStages)
              .where(eq(schema.projectPipelineStages.projectId, linkData.projectId));
            const statusToStageId = new Map<string, string>();
            for (const s of [...stageRows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
              if (s.systemStatus && !statusToStageId.has(s.systemStatus)) {
                statusToStageId.set(s.systemStatus, s.id);
              }
            }

            let pushed = 0;
            let restatused = 0;
            for (const task of tasks) {
              const effectiveStageId = task.stageId ?? statusToStageId.get(task.status) ?? null;
              const optionId = statusOptionForStageId(linkData.statusOptionMap, effectiveStageId);
              const existingItem = itemByTask.get(task.id);
              try {
                // Already on the board → reconcile its Status, never create again.
                if (existingItem) {
                  if (optionId && linkData.statusFieldId) {
                    await updateProjectItemStatus(
                      token,
                      linkData.projectV2NodeId,
                      existingItem,
                      linkData.statusFieldId,
                      optionId,
                    );
                    restatused++;
                  }
                  continue;
                }

                // ── Anti-duplicate safeguards (any ONE prevents a 2nd issue) ──
                // 1) Task already records an issue number (pushed before, any link).
                if (task.githubIssueNumber != null) continue;
                // 2) A sync-map row exists for this task under ANY link (taskId is
                //    globally unique in the map) — authoritative "already pushed".
                const [alreadyMapped] = await db
                  .select({ id: schema.githubIssueSyncMap.id })
                  .from(schema.githubIssueSyncMap)
                  .where(eq(schema.githubIssueSyncMap.taskId, task.id))
                  .limit(1);
                if (alreadyMapped) continue;

                const issue = await createIssue(token, repoFullName, {
                  title: task.title,
                  body: task.description,
                  labels: (task.labels as string[] | null) ?? undefined,
                });
                const itemNodeId = await addIssueToProject(token, linkData.projectV2NodeId, issue.node_id);
                if (optionId && linkData.statusFieldId) {
                  await updateProjectItemStatus(
                    token,
                    linkData.projectV2NodeId,
                    itemNodeId,
                    linkData.statusFieldId,
                    optionId,
                  );
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
                pushed++;
              } catch (err) {
                console.error(`[GithubProjectSync] Failed outbound for task ${task.id}:`, err);
              }
            }
            console.log(
              `[GithubProjectSync] Outbound reconcile for link ${projectLinkId}: created ${pushed}, restatused ${restatused}`,
            );
            return { pushed, restatused };
          },
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
