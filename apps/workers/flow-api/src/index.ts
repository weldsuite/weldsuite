/**
 * WeldSuite flow-api — the WeldFlow (projects, project members, labels,
 * messages, files, documents, sheets, pipeline stages and analytics, tasks,
 * task comments / tags / projects, my tasks, sprints, milestones, goals,
 * whiteboards, documents, time entries, task digest settings and the project-
 * control RAID log and links) module's API
 * worker, plus the SendDigest and ImportTasks workflows and the hourly task
 * digest cron.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { runDigestSweep } from './cron/digest-sweep';
import { isFinanceSnapshotCron, runFinanceSnapshots } from './cron/finance-snapshot';
import { isFilePurgeCron, runDeletedFilesPurge } from './cron/purge-deleted-files';
import { approvalsRoutes } from './routes/approvals';
import { capacityRoutes } from './routes/capacity';
import { digestSettingsRoutes } from './routes/digest-settings';
import { documentsRoutes } from './routes/documents';
import { goalsRoutes } from './routes/goals';
import { milestonesRoutes } from './routes/milestones';
import { myTasksRoutes } from './routes/my-tasks';
import { projectAnalyticsRoutes } from './routes/project-analytics';
import { projectBaselinesRoutes } from './routes/project-baselines';
import { projectBenefitsRoutes } from './routes/project-benefits';
import { projectChangesRoutes } from './routes/project-changes';
import { projectCloseRoutes } from './routes/project-close';
import { projectControlLinksRoutes } from './routes/project-control-links';
import { projectDecisionsRoutes } from './routes/project-decisions';
import { projectDeliverablesRoutes } from './routes/project-deliverables';
import { projectDocumentsRoutes } from './routes/project-documents';
import { projectFilesRoutes } from './routes/project-files';
import { projectFinanceRoutes } from './routes/project-finance';
import { projectLabelsRoutes } from './routes/project-labels';
import { projectLessonsRoutes } from './routes/project-lessons';
import { projectMembersRoutes } from './routes/project-members';
import { projectMessagesRoutes } from './routes/project-messages';
import { projectPhasesRoutes } from './routes/project-phases';
import { projectPipelineStagesRoutes } from './routes/project-pipeline-stages';
import { projectRaidRoutes } from './routes/project-raid';
import { projectRequestsRoutes } from './routes/project-requests';
import { projectScheduleRoutes } from './routes/project-schedule';
import { projectScopeRoutes } from './routes/project-scope';
import { projectSheetsRoutes } from './routes/project-sheets';
import { projectStakeholdersRoutes } from './routes/project-stakeholders';
import { projectStatusReportsRoutes } from './routes/project-status-reports';
import { projectTemplatesRoutes } from './routes/project-templates';
import { projectsRoutes } from './routes/projects';
import { publicProjectPortalRoutes } from './routes/public-project-portal';
import { sprintsRoutes } from './routes/sprints';
import { taskCommentsRoutes } from './routes/task-comments';
import { taskDependenciesRoutes } from './routes/task-dependencies';
import { taskProjectsRoutes } from './routes/task-projects';
import { taskTagsRoutes } from './routes/task-tags';
import { tasksRoutes } from './routes/tasks';
import { timeEntriesRoutes } from './routes/time-entries';
import { whiteboardsRoutes } from './routes/whiteboards';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'flow-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/documents', documentsRoutes);
app.route('/api/goals', goalsRoutes);
app.route('/api/milestones', milestonesRoutes);
app.route('/api/project-analytics', projectAnalyticsRoutes);
app.route('/api/project-control-links', projectControlLinksRoutes);
app.route('/api/project-files', projectFilesRoutes);
app.route('/api/project-labels', projectLabelsRoutes);
app.route('/api/project-documents', projectDocumentsRoutes);
app.route('/api/project-members', projectMembersRoutes);
app.route('/api/project-messages', projectMessagesRoutes);
app.route('/api/project-pipeline-stages', projectPipelineStagesRoutes);
app.route('/api/project-raid', projectRaidRoutes);
app.route('/api/project-sheets', projectSheetsRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/sprints', sprintsRoutes);
app.route('/api/task-comments', taskCommentsRoutes);
app.route('/api/task-projects', taskProjectsRoutes);
app.route('/api/task-tags', taskTagsRoutes);
app.route('/api/tasks', tasksRoutes);
app.route('/api/digest-settings', digestSettingsRoutes);
app.route('/api/my-tasks', myTasksRoutes);
app.route('/api/time-entries', timeEntriesRoutes);
app.route('/api/whiteboards', whiteboardsRoutes);

// WeldFlow project control and delivery (design: weldflow-project-control.md and
// weldflow-delivery-and-portfolio.md). Stubs until their slices fill them in.
app.route('/api/approvals', approvalsRoutes);
app.route('/api/capacity', capacityRoutes);
app.route('/api/project-baselines', projectBaselinesRoutes);
app.route('/api/project-benefits', projectBenefitsRoutes);
app.route('/api/project-changes', projectChangesRoutes);
app.route('/api/project-close', projectCloseRoutes);
app.route('/api/project-decisions', projectDecisionsRoutes);
app.route('/api/project-deliverables', projectDeliverablesRoutes);
app.route('/api/project-finance', projectFinanceRoutes);
app.route('/api/project-lessons', projectLessonsRoutes);
app.route('/api/project-phases', projectPhasesRoutes);
app.route('/api/project-requests', projectRequestsRoutes);
app.route('/api/project-schedule', projectScheduleRoutes);
app.route('/api/project-scope', projectScopeRoutes);
app.route('/api/project-stakeholders', projectStakeholdersRoutes);
app.route('/api/project-status-reports', projectStatusReportsRoutes);
app.route('/api/project-templates', projectTemplatesRoutes);
app.route('/api/task-dependencies', taskDependenciesRoutes);

// The client portal is public (a portal session, not Clerk): outside `/api/*`, so
// `apiAuth()` does not run.
app.route('/public/project-portal', publicProjectPortalRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// Daily task digests and bulk task imports, under the `send-digest-v3*` and
// `import-tasks-v3*` names: app-api keeps the `-v2*` names only while their
// in-flight instances drain.
export { SendDigestWorkflow } from '@weldsuite/flow-domain/workflows/send-digest';
export { ImportTasksWorkflow } from '@weldsuite/flow-domain/workflows/import-tasks';

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Hourly: send task digests (moved here from app-api's scheduled()).
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        runDigestSweep(env).catch((err) => {
          console.error('[DigestSweep] Failed:', err);
        }),
      );
    }
    // Daily: hard-delete files that were soft-deleted more than 30 days ago. Reads
    // only the D1 due index and opens just the workspaces that have a file due
    // (ADR DATA-008).
    if (isFilePurgeCron(event.cron)) {
      ctx.waitUntil(
        runDeletedFilesPurge(env).catch((err) => {
          console.error('[FilePurge] Failed:', err);
        }),
      );
    }
    // Daily: the weekly project finance snapshot, for the workspaces the
    // `finance_snapshot` due index lists (FLOW-019).
    if (isFinanceSnapshotCron(event.cron)) {
      ctx.waitUntil(
        runFinanceSnapshots(env).catch((err) => {
          console.error('[FinanceSnapshot] Failed:', err);
        }),
      );
    }
  },
};
