import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  resetProjectBranchRolePassword: vi.fn(),
  restartProjectEndpoint: vi.fn(),
}));

vi.mock('@neondatabase/api-client', () => ({ createApiClient: () => api }));

import { NeonApiError, NeonClient } from './client';

const client = new NeonClient({ apiKey: 'test-key' });

beforeEach(() => {
  api.resetProjectBranchRolePassword.mockReset();
  api.restartProjectEndpoint.mockReset();
});

describe('NeonClient.resetRolePassword', () => {
  it('returns the new password and the operations to wait for', async () => {
    const operations = [{ id: 'op-1', action: 'apply_config', status: 'running' }];
    api.resetProjectBranchRolePassword.mockResolvedValue({
      data: { role: { name: 'role_x', password: 'secret-new' }, operations },
    });

    const result = await client.resetRolePassword('prj-1', 'br-1', 'role_x');

    expect(api.resetProjectBranchRolePassword).toHaveBeenCalledWith('prj-1', 'br-1', 'role_x');
    expect(result).toEqual({ password: 'secret-new', operations });
  });

  it('fails when Neon returns no password rather than handing back an unusable result', async () => {
    api.resetProjectBranchRolePassword.mockResolvedValue({ data: { role: { name: 'role_x' }, operations: [] } });

    await expect(client.resetRolePassword('prj-1', 'br-1', 'role_x')).rejects.toMatchObject({
      name: 'NeonApiError',
      status: 502,
    });
  });

  it('maps API errors like every other call', async () => {
    api.resetProjectBranchRolePassword.mockRejectedValue({
      response: { status: 404, data: { message: 'role not found', code: 'NOT_FOUND' } },
    });

    const error = await client.resetRolePassword('prj-1', 'br-1', 'role_x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeonApiError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'role not found' });
  });
});

describe('NeonClient.restartEndpoint', () => {
  it('returns the restart operations', async () => {
    const operations = [{ id: 'op-9', action: 'suspend_compute', status: 'running' }];
    api.restartProjectEndpoint.mockResolvedValue({ data: { operations } });

    await expect(client.restartEndpoint('prj-1', 'ep-1')).resolves.toEqual(operations);
    expect(api.restartProjectEndpoint).toHaveBeenCalledWith('prj-1', 'ep-1');
  });

  it('returns no operations when the response has none', async () => {
    api.restartProjectEndpoint.mockResolvedValue({ data: {} });
    await expect(client.restartEndpoint('prj-1', 'ep-1')).resolves.toEqual([]);
  });

  it('maps API errors', async () => {
    api.restartProjectEndpoint.mockRejectedValue({ response: { status: 423, data: { message: 'locked' } } });
    await expect(client.restartEndpoint('prj-1', 'ep-1')).rejects.toMatchObject({ name: 'NeonApiError', status: 423 });
  });
});
