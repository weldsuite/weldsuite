/**
 * WeldSuite agent-api — the WeldAgent (workspace agents, conversations,
 * routines, skills, memories, approvals, the AI endpoints and the model
 * catalog) module's API worker. It also runs the WeldAgent runtime's
 * non-HTTP work: the entity-agents* queue consumer (agent eventSubscriptions),
 * the hourly routine sweep and the WeldAgentJob workflow.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { registerWeldAgentEventRunner, type EntityEventMessage } from '@weldsuite/entity-events';
import { dispatchWeldAgentsForEvent } from './services/weldagent/dispatch';
import { runWeldAgentRoutineSweep } from './cron/weldagent-routines';
import { handleEntityAgentBatch } from './queue/entity-agents-consumer';
import { aiModelsRoutes } from './routes/ai-models';
import { aiRoutes } from './routes/ai';
import { chatAgentRoutes } from './routes/chat-agent';
import { weldagentRoutes } from './routes/weldagent';
import type { Env, Variables } from './types';

// Register entity-event → workspace agent dispatch (Phase 5: hub → entity-agents*).
registerWeldAgentEventRunner(async (payload) => {
  await dispatchWeldAgentsForEvent(payload.env as Env, payload.db as never, {
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    entityType: payload.entityType,
    action: payload.action,
    entityId: payload.entityId,
    data: payload.data,
    eventId: payload.eventId,
  });
});

const app = createModuleApi<Env, Variables>({ service: 'agent-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/chat-agent', chatAgentRoutes);
app.route('/api/ai-models', aiModelsRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/weldagent', weldagentRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// WeldAgent background runs, under the `weldagent-job-v2*` names: app-api
// keeps `weldagent-job*` only while its in-flight instances drain.
export { WeldAgentJobWorkflow } from '@weldsuite/agent-domain/workflows/weldagent-job';

export default {
  fetch: app.fetch,
  /**
   * Queue consumer: entity-agents* — WeldAgent eventSubscriptions (Phase 5
   * hub SUB_WELDAGENT).
   */
  queue: async (batch: MessageBatch<EntityEventMessage>, env: Env) => {
    if (batch.queue.startsWith('entity-agents')) {
      await handleEntityAgentBatch(batch, env);
      return;
    }
    console.warn(`[agent-api] no consumer registered for queue "${batch.queue}"`);
  },
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Hourly: WeldAgent routines.
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        runWeldAgentRoutineSweep(env).catch((err) => {
          console.error('[WeldAgentRoutineSweep] Failed:', err);
        }),
      );
    }
  },
};
