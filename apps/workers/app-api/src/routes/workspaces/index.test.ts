/**
 * Route-level tests for /api/workspaces. The service layer is mocked —
 * these assert the route wiring, the success envelope, and that a failed
 * lookup is an error rather than an empty list.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspacesRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('@weldsuite/core-domain/workspaces', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/core-domain/workspaces')>(
    '@weldsuite/core-domain/workspaces',
  );
  return { ...actual, listUserWorkspaces: vi.fn() };
});

import * as workspacesService from '@weldsuite/core-domain/workspaces';

const mockedList = workspacesService.listUserWorkspaces as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/workspaces', () => {
  it('200 with the workspace list envelope', async () => {
    mockedList.mockResolvedValueOnce([
      {
        id: 'org_1',
        workspaceId: 'ws_1',
        name: 'Acme',
        slug: 'acme',
        imageUrl: null,
        role: 'org:admin',
      },
    ]);
    const { request } = createTestApp('/api/workspaces', workspacesRoutes, {
      // Well-formed URL so `getMasterDb` can construct the (unused, mocked) client.
      env: { DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db' },
    });
    const res = await request('/api/workspaces');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('org_1');
  });

  it('answers 500 when the lookup fails, not an empty list (which means no workspaces)', async () => {
    mockedList.mockRejectedValueOnce(new Error('master db down'));
    const { request } = createTestApp('/api/workspaces', workspacesRoutes);
    const res = await request('/api/workspaces');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Failed to list workspaces' });
  });
});
