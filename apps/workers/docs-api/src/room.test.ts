import { describe, expect, it, vi } from 'vitest';
import { fakeObjectState } from '@weldsuite/docs-domain/test-support/fakes';
import type { Env } from '@weldsuite/docs-domain/types';
import { DocRoom } from './room';

const opened = vi.hoisted(() => ({ calls: [] as unknown[][], db: { tenant: true } }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async (...args: unknown[]) => {
    opened.calls.push(args);
    return opened.db;
  },
}));

describe('DocRoom on docs-api', () => {
  it('opens the workspace database through worker-kit, with the worker env', async () => {
    const env = { PRIVATE_STORAGE: {} } as unknown as Env;
    const room = new DocRoom(fakeObjectState().ctx as unknown as DurableObjectState, env);
    const tenantDb = (room as unknown as { tenantDb(workspaceId: string): Promise<unknown> }).tenantDb.bind(room);
    await expect(tenantDb('org_room')).resolves.toBe(opened.db);
    expect(opened.calls).toHaveLength(1);
    expect(opened.calls[0]![0]).toBe(env);
    expect(opened.calls[0]![1]).toBe('org_room');
  });
});
