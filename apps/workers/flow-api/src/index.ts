/**
 * WeldSuite flow-api — the WeldFlow (projects, project members, labels,
 * messages, files, documents, sheets, pipeline stages and analytics, tasks,
 * task comments / tags / projects, my tasks, sprints, milestones, goals,
 * whiteboards, documents, time entries and task digest settings) module's API
 * worker, plus the SendDigest and ImportTasks workflows and the hourly task
 * digest cron.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { runDigestSweep } from './cron/digest-sweep';
import { digestSettingsRoutes } from './routes/digest-settings';
import { documentsRoutes } from './routes/documents';
import { goalsRoutes } from './routes/goals';
import { milestonesRoutes } from './routes/milestones';
import { myTasksRoutes } from './routes/my-tasks';
import { projectAnalyticsRoutes } from './routes/project-analytics';
import { projectDocumentsRoutes } from './routes/project-documents';
import { projectFilesRoutes } from './routes/project-files';
import { projectLabelsRoutes } from './routes/project-labels';
import { projectMembersRoutes } from './routes/project-members';
import { projectMessagesRoutes } from './routes/project-messages';
import { projectPipelineStagesRoutes } from './routes/project-pipeline-stages';
import { projectSheetsRoutes } from './routes/project-sheets';
import { projectsRoutes } from './routes/projects';
import { sprintsRoutes } from './routes/sprints';
import { taskCommentsRoutes } from './routes/task-comments';
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
app.route('/api/project-files', projectFilesRoutes);
app.route('/api/project-labels', projectLabelsRoutes);
app.route('/api/project-documents', projectDocumentsRoutes);
app.route('/api/project-members', projectMembersRoutes);
app.route('/api/project-messages', projectMessagesRoutes);
app.route('/api/project-pipeline-stages', projectPipelineStagesRoutes);
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
  },
};
