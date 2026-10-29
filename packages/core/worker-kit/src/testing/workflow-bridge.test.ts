import { describe, expect, it } from 'vitest';
import { workflowBridgeUrl, type WorkflowLike } from './workflow-bridge';

/** A Workflow binding stub whose first `create` fails, like a Workflows API outage. */
function flaky() {
  const calls: string[] = [];
  const instances = new Map<string, { status: string; restarted: number }>();
  let failNext = true;
  const binding: WorkflowLike = {
    async create({ id }) {
      calls.push(id);
      if (failNext) {
        failNext = false;
        throw new Error('Workflows API unavailable');
      }
      if (instances.has(id)) throw new Error('instance.already_exists');
      instances.set(id, { status: 'running', restarted: 0 });
      return { id };
    },
    async get(id) {
      const instance = instances.get(id);
      if (!instance) throw new Error('instance.not_found');
      return {
        status: async () => ({ status: instance.status }),
        restart: async () => {
          instance.restarted++;
          instance.status = 'running';
        },
      };
    },
  };
  return { binding, calls, instances };
}

const start = (base: string, key: string) =>
  fetch(`${base}/start`, { method: 'POST', body: JSON.stringify({ name: 'sign.finalize', key, payload: { envelopeId: 'sgn_1' } }) });

describe('workflow bridge', () => {
  it('starts one run per key, and restarts one that failed', async () => {
    const stub = flaky();
    const base = await workflowBridgeUrl(stub.binding);
    expect(await workflowBridgeUrl(stub.binding)).toBe(base);

    // The API fails and there is no instance: not started.
    const refused = await start(base, 'finalize-sgn_1');
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('Workflows API unavailable');
    expect((await start(base, 'finalize-sgn_1')).status).toBe(204);
    // Running: left alone.
    expect((await start(base, 'finalize-sgn_1')).status).toBe(204);
    expect(stub.instances.get('finalize-sgn_1')).toEqual({ status: 'running', restarted: 0 });
    // Errored: restarted.
    stub.instances.get('finalize-sgn_1')!.status = 'errored';
    expect((await start(base, 'finalize-sgn_1')).status).toBe(204);
    expect(stub.instances.get('finalize-sgn_1')).toEqual({ status: 'running', restarted: 1 });
    expect(stub.calls).toEqual(Array(4).fill('finalize-sgn_1'));

    expect((await fetch(`${base}/start`, { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
  });
});
