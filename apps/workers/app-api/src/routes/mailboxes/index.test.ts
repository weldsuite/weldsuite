/**
 * Route-level tests for GET /api/mailboxes. The service is mocked — these
 * assert the success envelope and the empty-list fallback on error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mailboxesRoutes } from './index';
import { createTestApp } from '../../test/harness';

vi.mock('../../services/mail/mailboxes', () => ({
  listUserMailboxes: vi.fn(),
}));

import * as mailboxesService from '../../services/mail/mailboxes';

const mockedList = mailboxesService.listUserMailboxes as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/mailboxes', () => {
  it('200 with the mailbox directory envelope', async () => {
    mockedList.mockResolvedValueOnce([
      {
        clerkOrgId: 'org_1',
        workspaceId: 'ws_1',
        workspaceName: 'Acme',
        slug: 'acme',
        imageUrl: null,
        role: 'org:admin',
        accounts: [
          {
            id: 'mail_1',
            email: 'hello@acme.test',
            displayName: 'Hello',
            provider: 'weldmail',
            isDefault: true,
            status: 'active',
          },
        ],
      },
    ]);
    const { request } = createTestApp('/api/mailboxes', mailboxesRoutes);
    const res = await request('/api/mailboxes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ clerkOrgId: string; accounts: Array<{ email: string }> }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].clerkOrgId).toBe('org_1');
    expect(body.data[0].accounts[0].email).toBe('hello@acme.test');
  });

  it('falls back to an empty list when the lookup fails', async () => {
    mockedList.mockRejectedValueOnce(new Error('master db down'));
    const { request } = createTestApp('/api/mailboxes', mailboxesRoutes);
    const res = await request('/api/mailboxes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});
