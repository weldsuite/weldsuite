/**
 * WeldAgentJobWorkflow — Cloudflare Workflow
 *
 * Runs WeldAgent background work (chat replies, connector routines, WeldChat
 * room replies) outside the request lifetime. See services/weldagent/jobs.ts.
 *
 * The single step never retries: an agent turn has side effects (created
 * records, sandbox commands), so replaying it could duplicate them. Failures
 * are persisted by the job itself (an error reply / failed run row).
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types';
import { runWeldAgentJob, type WeldAgentJob } from '../services/weldagent/jobs';

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
