/**
 * WeldAgentJobWorkflow — Cloudflare Workflow
 *
 * Runs WeldAgent background work (chat replies, connector routines, WeldChat
 * room replies) outside the request lifetime. See ../jobs.ts.
 *
 * The single step never retries: an agent turn has side effects (created
 * records, sandbox commands), so replaying it could duplicate them. Failures
 * are persisted by the job itself (an error reply / failed run row).
 *
 * Hosted in agent-api under the workflow names `weldagent-job-v2[-dev]` (bound
 * as WELDAGENT_JOB and re-exported from agent-api's src/index.ts); chat-api
 * binds it cross-script to hand off WeldChat room replies. app-api keeps its
 * old `weldagent-job*` names and re-exports this class only while their
 * in-flight instances drain (docs/plans/app-api-module-split.md, "Workflows
 * draining in app-api").
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WeldAgentEnv as Env } from '../env';
import { runWeldAgentJob, type WeldAgentJob } from '../jobs';

export class WeldAgentJobWorkflow extends WorkflowEntrypoint<Env, WeldAgentJob> {
  async run(event: WorkflowEvent<WeldAgentJob>, step: WorkflowStep) {
    await step.do(
      `weldagent-${event.payload.kind}`,
      { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' },
      async () => {
        await runWeldAgentJob(this.env, event.payload);
      },
    );
  }
}
