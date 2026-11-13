/**
 * Reading WeldSuite's workspace list for the OIDC session: names and slugs
 * the provider's token doesn't carry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { loadWorkspacesFromApi, parseWorkspaceDirectory } from './workspaces';

const API = 'https://weldsuite.example.eu';

afterEach(() => {
  vi.unstubAllGlobals();
  setRuntimeConfig(null);
});

function stubFetch(respond: () => Promise<Response>) {
  const fetch = vi.fn(respond);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('loadWorkspacesFromApi', () => {
  it('asks the API with the session token and reads the list', async () => {
    setRuntimeConfig({ backend: 'rust', apiBaseUrl: API });
    const fetch = stubFetch(async () =>
      Response.json({ data: [{ id: 'org_acme', workspaceId: 'ws_1', name: 'Acme', slug: 'acme', role: 'OWNER' }] }),
    );

    await expect(loadWorkspacesFromApi('at-1')).resolves.toEqual([{ id: 'org_acme', name: 'Acme', slug: 'acme' }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/workspaces`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer at-1' });
  });

  it('answers null when the API refuses or is unreachable', async () => {
    setRuntimeConfig({ backend: 'rust', apiBaseUrl: API });
    stubFetch(async () => Response.json({ error: { code: 'ORG_REQUIRED' } }, { status: 400 }));
    await expect(loadWorkspacesFromApi('at-1')).resolves.toBeNull();

    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(loadWorkspacesFromApi('at-1')).resolves.toBeNull();
  });
});

describe('parseWorkspaceDirectory', () => {
  it('keeps entries with an id and a name, and a slug when there is one', () => {
    expect(
      parseWorkspaceDirectory({
        data: [
          { id: 'org_acme', name: 'Acme', slug: 'acme' },
          { id: 'org_new', name: 'New Co', slug: '' },
          { id: 'org_x', name: '' },
          null,
        ],
      }),
    ).toEqual([
      { id: 'org_acme', name: 'Acme', slug: 'acme' },
      { id: 'org_new', name: 'New Co', slug: null },
    ]);
    expect(parseWorkspaceDirectory(null)).toBeNull();
    expect(parseWorkspaceDirectory({ data: 'nope' })).toBeNull();
  });
});
