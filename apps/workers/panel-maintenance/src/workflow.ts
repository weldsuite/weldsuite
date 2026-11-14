/**
 * PanelMaintenanceWorkflow: one weekly rewrite of the Iceberg tables.
 *
 *   plan     take what the ledger holds and the retention of every project
 *   start    hand the spec to the container job (idempotent by run id)
 *   poll     sleep and ask, until the job is done (it can take a while on a big table)
 *   finish   tell each project object to stop excluding the erased ids, and
 *            drop them from the ledger
 *   stop     shut the container down, also when the job failed
 *
 * The ids leave the ledger only after the rewrite succeeded. A failed run
 * leaves them where they are, the project objects keep excluding them from
 * queries, and the next run covers them again. Every step is safe to repeat.
 *
 * It runs as a Workflow because the rewrite outlasts a queue consumer or a
 * cron handler (docs/plans/weldpanel.md: the PyIceberg job on Containers).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import type { Env } from './env';
import { JOB_NAME, LEDGER_NAME } from './messages';
import type { JobStatus } from './container';
import { buildSpec, loadRetention, type MaintenanceJobResult, type MaintenanceJobSpec } from './spec';

/** The workflow takes no parameters: it reads what to do. */
export type MaintenanceParams = Record<string, never>;

export const POLL_INTERVAL = '30 seconds';
/** Two hours of polling at {@link POLL_INTERVAL}. */
export const MAX_POLLS = 240;

type JobStub = ReturnType<Env['MAINTENANCE_JOB']['get']>;

// A step must return plain data, not the stub's RPC promise: copy what it answered.
async function startJob(job: JobStub, spec: MaintenanceJobSpec): Promise<{ jobId: string }> {
  const { jobId } = await job.start(spec);
  return { jobId };
}

async function pollJob(job: JobStub, jobId: string): Promise<JobStatus> {
  const status = await job.status(jobId);
  if (status.state === 'done') return { state: 'done', result: status.result };
  if (status.state === 'failed') return { state: 'failed', error: status.error };
  return { state: 'running' };
}

export interface MaintenanceRunSummary {
  runId: string;
  erasedProjects: number;
  erasedIds: number;
  result: MaintenanceJobResult;
}

export class PanelMaintenanceWorkflow extends WorkflowEntrypoint<Env, MaintenanceParams> {
  async run(event: WorkflowEvent<MaintenanceParams>, step: WorkflowStep): Promise<MaintenanceRunSummary> {
    const env = this.env;
    const ledger = () => env.MAINTENANCE_LEDGER.get(env.MAINTENANCE_LEDGER.idFromName(LEDGER_NAME));
    const job = () => env.MAINTENANCE_JOB.get(env.MAINTENANCE_JOB.idFromName(JOB_NAME));

    const spec = await step.do('plan', async (): Promise<MaintenanceJobSpec> => {
      const [erasures, retention] = await Promise.all([ledger().pending(), loadRetention(getMasterDb(env))]);
      return buildSpec({ runId: event.instanceId, now: new Date(), erasures, retention });
    });

    let result: MaintenanceJobResult | null = null;
    try {
      const { jobId } = await step.do('start', { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, () => startJob(job(), spec));

      for (let poll = 0; poll < MAX_POLLS && !result; poll += 1) {
        await step.sleep(`wait ${poll}`, POLL_INTERVAL);
        const status = await step.do(`poll ${poll}`, { retries: { limit: 5, delay: '10 seconds', backoff: 'linear' }, timeout: '2 minutes' }, () => pollJob(job(), jobId));
        if (status.state === 'failed') throw new NonRetryableError(`The maintenance job failed: ${status.error}`);
        if (status.state === 'done') result = status.result;
      }
      if (!result) throw new NonRetryableError('The maintenance job did not finish in time');
    } catch (error) {
      await step.do('stop container after failure', async () => {
        await job().stop();
      });
      throw error;
    }

    const finished = result;
    const settled = await step.do('finish', async () => {
      let ids = 0;
      let projects = 0;
      for (const erasure of spec.erasures) {
        // Ids queued again after the plan were not covered by this rewrite and stay.
        const covered = await ledger().settled(erasure.projectId, erasure.ids, spec.now);
        if (covered.length === 0) continue;
        await projectObjectStub(env.PANEL_PROJECT, erasure.projectId).clearErased(covered);
        await ledger().complete(erasure.projectId, covered);
        ids += covered.length;
        projects += 1;
      }
      await ledger().recordRun({ runId: spec.runId, finishedAt: new Date().toISOString(), erasedIds: ids, summary: JSON.stringify(finished) });
      return { ids, projects };
    });

    await step.do('stop container', async () => {
        await job().stop();
      });
    return { runId: spec.runId, erasedProjects: settled.projects, erasedIds: settled.ids, result: finished };
  }
}
