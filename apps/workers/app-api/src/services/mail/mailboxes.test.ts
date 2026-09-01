import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listUserMailboxes } from './mailboxes';
import type { Env } from '../../types';

vi.mock('../workspaces', () => ({
  listUserWorkspaces: vi.fn(),
}));

vi.mock('./accounts', () => ({
  listMailAccounts: vi.fn(),
}));

vi.mock('../../db', () => ({
  getMasterDb: vi.fn(() => ({})),
  getWorkspaceContextForOrg: vi.fn(),
}));

import { listUserWorkspaces } from '../workspaces';
import { listMailAccounts } from './accounts';
import { getWorkspaceContextForOrg } from '../../db';

const mockedListWorkspaces = listUserWorkspaces as ReturnType<typeof vi.fn>;
const mockedListAccounts = listMailAccounts as ReturnType<typeof vi.fn>;
const mockedContext = getWorkspaceContextForOrg as ReturnType<typeof vi.fn>;

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listUserMailboxes', () => {
  it('returns accounts grouped by workspace', async () => {
    mockedListWorkspaces.mockResolvedValueOnce([
      {
        id: 'org_1',
        workspaceId: 'ws_1',
        name: 'Acme',
        slug: 'acme',
        imageUrl: null,
        role: 'org:admin',
      },
    ]);
    mockedContext.mockResolvedValueOnce({ db: {}, suspended: false });
    mockedListAccounts.mockResolvedValueOnce({
      data: [
        {
          id: 'mail_1',
          email: 'hello@acme.test',
          displayName: 'Hello',
          name: 'Hello',
          provider: 'weldmail',
          isDefault: true,
          status: 'active',
        },
      ],
    });

    const groups = await listUserMailboxes(env, 'user_1');
    expect(groups).toHaveLength(1);
    expect(groups[0].clerkOrgId).toBe('org_1');
    expect(groups[0].accounts[0].email).toBe('hello@acme.test');
  });

  it('skips a workspace whose tenant lookup fails without hiding the rest', async () => {
    mockedListWorkspaces.mockResolvedValueOnce([
      { id: 'org_bad', workspaceId: 'ws_bad', name: 'Bad', slug: 'bad', imageUrl: null, role: 'org:member' },
      { id: 'org_ok', workspaceId: 'ws_ok', name: 'Ok', slug: 'ok', imageUrl: null, role: 'org:member' },
    ]);
    mockedContext
      .mockRejectedValueOnce(new Error('missing db'))
      .mockResolvedValueOnce({ db: {}, suspended: false });
    mockedListAccounts.mockResolvedValueOnce({
      data: [{ id: 'mail_2', email: 'ok@ok.test', displayName: 'Ok', name: 'Ok', provider: null, isDefault: false, status: 'active' }],
    });

    const groups = await listUserMailboxes(env, 'user_1');
    expect(groups).toHaveLength(2);
    expect(groups[0].accounts).toEqual([]);
    expect(groups[1].accounts[0].email).toBe('ok@ok.test');
  });
});
