/**
 * MaintenanceJob: the Cloudflare Container that runs the PyIceberg job
 * (container/), driven over HTTP on port 8080 through the Durable Object's
 * container handle.
 *
 *   POST /jobs        a {@link MaintenanceJobSpec}; answers 202 with the job id
 *                     (the spec's `runId`; starting it again answers the same job)
 *   GET  /jobs/<id>   { state: 'running' | 'done' | 'failed', result?, error? }
 *
 * The container starts on the first call and is destroyed by `stop()`. It gets
 * the Data Catalog address and token as environment variables, never as part of
 * the spec, so they do not travel through workflow history.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { catalogFor, type MaintenanceJobResult, type MaintenanceJobSpec } from './spec';

export const JOB_PORT = 8080;
const START_ATTEMPTS = 30;
const START_DELAY_MS = 1000;

export type JobStatus =
  | { state: 'running' }
  | { state: 'done'; result: MaintenanceJobResult }
  | { state: 'failed'; error: string };

export class MaintenanceJob extends DurableObject<Env> {
  /** Replaced in tests, so retries do not take real seconds. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('This Durable Object has no container: check [[containers]] in wrangler.toml');
    return container;
  }

  private startIfNeeded(): Container {
    const container = this.container();
    if (!container.running) {
      const catalog = catalogFor(this.env);
      container.start({
        enableInternet: true,
        env: {
          CATALOG_URI: catalog.uri,
          CATALOG_WAREHOUSE: catalog.warehouse,
          CATALOG_TOKEN: this.env.PANEL_CATALOG_TOKEN,
        },
      });
    }
    return container;
  }

  /** Calls the container, waiting for its server to come up the first time. */
  private async call(path: string, init?: RequestInit): Promise<Response> {
    const port = this.startIfNeeded().getTcpPort(JOB_PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      try {
        return await port.fetch(`http://container${path}`, init);
      } catch (error) {
        lastError = error;
        await this.sleep(START_DELAY_MS);
      }
    }
    throw new Error(`The maintenance container did not answer: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  async start(spec: MaintenanceJobSpec): Promise<{ jobId: string }> {
    const response = await this.call('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(`The maintenance container refused the job (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { jobId?: string };
    if (!body.jobId) throw new Error('The maintenance container answered without a job id');
    return { jobId: body.jobId };
  }

  async status(jobId: string): Promise<JobStatus> {
    const response = await this.call(`/jobs/${encodeURIComponent(jobId)}`);
    if (response.status === 404) return { state: 'failed', error: 'The container does not know this job (it restarted)' };
    if (!response.ok) throw new Error(`The maintenance container answered ${response.status}`);
    return (await response.json()) as JobStatus;
  }

  /** Shuts the container down. Safe to call when it is not running. */
  async stop(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
  }
}
