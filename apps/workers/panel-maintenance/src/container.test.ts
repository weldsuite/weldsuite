/**
 * MaintenanceJob drives the container over HTTP on port 8080. A fake
 * `ctx.container` stands in for it: what it is started with, how the first
 * calls wait for its server, how the job's answers map to a status.
 */

import { describe, expect, it, vi } from 'vitest';
import { JOB_PORT, MaintenanceJob } from './container';
import type { Env } from './env';
import type { MaintenanceJobSpec } from './spec';

const spec: MaintenanceJobSpec = {
  runId: 'maintenance-2026-11-15',
  now: '2026-11-15T03:00:00.000Z',
  erasures: [{ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1'] }],
  retention: [{ months: 12, projectIds: ['pnp_1'] }],
  maxRetentionMonths: 25,
};

const env = { CF_ACCOUNT_ID: 'acc1', PANEL_BASIN_BUCKET: 'weldsuite-panel-test', PANEL_CATALOG_TOKEN: 'catalog-token' } as Env;

function create(answers: Array<Response | Error>) {
  let running = false;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchPort = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  const container = {
    get running() {
      return running;
    },
    start: vi.fn(() => {
      running = true;
    }),
    destroy: vi.fn(async () => {
      running = false;
    }),
    getTcpPort: vi.fn(() => ({ fetch: fetchPort })),
  };
  const job = new MaintenanceJob({ container } as unknown as DurableObjectState, env);
  job.sleep = async () => undefined;
  return { job, container, requests, fetchPort };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('MaintenanceJob', () => {
  it('starts the container with the catalog address and token as environment, never in the spec', async () => {
    const { job, container, requests } = create([json({ jobId: spec.runId }, 202)]);
    expect(await job.start(spec)).toEqual({ jobId: 'maintenance-2026-11-15' });

    expect(container.start).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith({
      enableInternet: true,
      env: {
        CATALOG_URI: 'https://catalog.cloudflarestorage.com/acc1/weldsuite-panel-test',
        CATALOG_WAREHOUSE: 'acc1_weldsuite-panel-test',
        CATALOG_TOKEN: 'catalog-token',
      },
    });
    expect(container.getTcpPort).toHaveBeenCalledWith(JOB_PORT);
    expect(requests[0]!.url).toBe('http://container/jobs');
    expect(requests[0]!.init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(requests[0]!.init!.body))).toEqual(spec);
    expect(String(requests[0]!.init!.body)).not.toContain('catalog-token');
  });

  it('does not start a container that is already running', async () => {
    const { job, container } = create([json({ jobId: spec.runId }, 202)]);
    await job.start(spec);
    await job.start(spec);
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it('waits for the server in the container to come up', async () => {
    const { job, fetchPort } = create([new Error('connection refused'), new Error('connection refused'), json({ jobId: spec.runId }, 202)]);
    expect(await job.start(spec)).toEqual({ jobId: spec.runId });
    expect(fetchPort).toHaveBeenCalledTimes(3);
  });

  it('gives up when the server never answers', async () => {
    const { job, fetchPort } = create([new Error('connection refused')]);
    await expect(job.start(spec)).rejects.toThrow(/did not answer: connection refused/);
    expect(fetchPort).toHaveBeenCalledTimes(30);
  });

  it('refuses a job the container refuses (another one is running)', async () => {
    const { job } = create([json({ error: 'another job is running' }, 409)]);
    await expect(job.start(spec)).rejects.toThrow(/refused the job \(409\)/);
  });

  it('maps the three job states', async () => {
    const result = { erased: { events: 3, identities: 1, people: 1, replayChunks: 2 }, expired: { events: 10, replayChunks: 4 } };
    const done = create([json({ state: 'done', result })]);
    expect(await done.job.status('maintenance-2026-11-15')).toEqual({ state: 'done', result });
    expect(done.requests[0]!.url).toBe('http://container/jobs/maintenance-2026-11-15');

    const failed = create([json({ state: 'failed', error: 'CommitFailedException: nope' })]);
    expect(await failed.job.status('r')).toEqual({ state: 'failed', error: 'CommitFailedException: nope' });

    const running = create([json({ state: 'running' })]);
    expect(await running.job.status('r')).toEqual({ state: 'running' });
  });

  it('treats a job the container does not know (it restarted) as failed, so the run stops and repeats', async () => {
    const { job } = create([json({ error: 'unknown job' }, 404)]);
    expect(await job.status('r')).toMatchObject({ state: 'failed' });
  });

  it('throws on a server error, so the step is retried', async () => {
    const { job } = create([json({}, 500)]);
    await expect(job.status('r')).rejects.toThrow(/answered 500/);
  });

  it('stops a running container and does nothing when there is none', async () => {
    const { job, container } = create([json({ jobId: spec.runId }, 202)]);
    await job.stop();
    expect(container.destroy).not.toHaveBeenCalled();

    await job.start(spec);
    await job.stop();
    expect(container.destroy).toHaveBeenCalledTimes(1);
  });

  it('says so when the object has no container configured', async () => {
    const job = new MaintenanceJob({} as DurableObjectState, env);
    await expect(job.start(spec)).rejects.toThrow(/no container/);
  });
});
