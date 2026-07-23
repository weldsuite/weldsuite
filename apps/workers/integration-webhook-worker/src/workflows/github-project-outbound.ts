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

        let linkId: string | null = null;
        if (syncMapRow) {
          linkId = syncMapRow.projectLinkId;
        } else if (kind === 'create') {
          if (paramLinkId) {
            linkId = paramLinkId;
          } else if (task.projectId) {
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
            linkId = byProject?.id ?? null;
          }
        }

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

        // Status→stage fallback: tasks may have a null stageId and only carry
        // `status`; map task.status → stageId via the project's pipeline stages.
        const stageRows = await db
          .select({
            id: schema.projectPipelineStages.id,
            systemStatus: schema.projectPipelineStages.systemStatus,
            position: schema.projectPipelineStages.position,
          })
          .from(schema.projectPipelineStages)
          .where(eq(schema.projectPipelineStages.projectId, link.projectId));
        const statusToStageId: Record<string, string> = {};
        for (const s of [...stageRows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
          if (s.systemStatus && !(s.systemStatus in statusToStageId)) {
            statusToStageId[s.systemStatus] = s.id;
          }
        }

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

        if (kind === 'create') {
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

          const optionId = statusOptionForStageId(link.statusOptionMap, effectiveStageId);
          if (optionId && link.statusFieldId) {
            await updateProjectItemStatus(token, link.projectV2NodeId, itemNodeId, link.statusFieldId, optionId);
          }

          return {
            issueNumber: issue.number,
            issueNodeId: issue.node_id,
            projectItemNodeId: itemNodeId,
            issueUpdatedAt: issue.updated_at,
          };
        }

        const map = syncMap!;

        if (kind === 'update') {
          if (!map.issueNodeId) {
            console.log(`[GithubProjectOutbound] No issueNodeId for task ${taskId} — skipping update`);
            return null;
          }
          const updatedAt = await updateIssueFields(token, map.issueNodeId, {
            title: task.title,
            body: task.description,
          });
          return { issueUpdatedAt: updatedAt };
        }

        if (kind === 'status') {
          // 1) Set the mapped Status column (if we have a mapping for this stage).
          const optionId = statusOptionForStageId(link.statusOptionMap, effectiveStageId);
          if (optionId && link.statusFieldId) {
            await updateProjectItemStatus(
              token,
              link.projectV2NodeId,
              map.projectItemNodeId,
              link.statusFieldId,
              optionId,
            );
          }
          // 2) Mirror open/closed state onto the issue (best-effort; idempotent).
          let issueUpdatedAt = new Date().toISOString();
          if (map.issueNodeId) {
            try {
              if (task.status === 'done') {
                issueUpdatedAt = await closeIssue(token, map.issueNodeId, 'COMPLETED');
              } else if (task.status === 'cancelled') {
                issueUpdatedAt = await closeIssue(token, map.issueNodeId, 'NOT_PLANNED');
              } else {
                issueUpdatedAt = await reopenIssue(token, map.issueNodeId);
              }
            } catch (e) {
              console.log(
                `[GithubProjectOutbound] issue state change skipped for task ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          return { issueUpdatedAt };
        }

        if (kind === 'delete') {
          if (!map.issueNodeId) return null;
          const updatedAt = await closeIssue(token, map.issueNodeId, 'NOT_PLANNED');
          return { issueUpdatedAt: updatedAt };
        }

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
