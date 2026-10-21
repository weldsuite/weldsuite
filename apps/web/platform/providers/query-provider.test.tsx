import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, dehydrate } from '@tanstack/react-query';

const auth = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  orgId: 'org_acme' as string | null,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ ...auth }),
}));

import { QueryProvider } from './query-provider';
import { queryClient } from '@/lib/query-client';
import { setWritableQueryCacheOrg } from '@/lib/persisted-query-cache';

// The persister writes on a 1s throttle.
const WRITE_WAIT = { timeout: 3000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Set a query until it shows up in `orgId`'s entry: the provider subscribes
 * only after its restore, so a write made before that is never persisted.
 */
async function setUntilPersisted(orgId: string, key: string, value: string) {
  await waitFor(() => {
    act(() => {
      queryClient.setQueryData([key], [value]);
    });
    expect(localStorage.getItem(`weldsuite:query-cache:${orgId}`)).toContain(value);
  }, WRITE_WAIT);
}

/** A persisted cache entry for `orgId` holding `['owner']` = `owner`. */
function persistedEntry(orgId: string, owner: string): string {
  const client = new QueryClient();
  client.setQueryData(['owner'], owner);
  return JSON.stringify({ buster: `v2:${orgId}`, timestamp: Date.now(), clientState: dehydrate(client) });
}

function renderProvider() {
  return render(
    <QueryProvider>
      <div />
    </QueryProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  auth.isLoaded = true;
  auth.isSignedIn = true;
  auth.orgId = 'org_acme';
});

afterEach(async () => {
  cleanup();
  setWritableQueryCacheOrg(null);
  // Let a throttled write still pending from this test fire (and be dropped)
  // before the next test makes an org writable again.
  await sleep(1100);
  queryClient.clear();
});

describe('QueryProvider', () => {
  it("restores the active workspace's own entry, not another tab's", async () => {
    localStorage.setItem('weldsuite:query-cache:org_globex', persistedEntry('org_globex', 'globex'));
    localStorage.setItem('weldsuite:query-cache:org_acme', persistedEntry('org_acme', 'acme'));
    renderProvider();

    await waitFor(() => expect(queryClient.getQueryData(['owner'])).toBe('acme'));
    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).toContain('"globex"');
  });

  it("writes to the active workspace's key and leaves other workspaces alone", async () => {
    const globex = persistedEntry('org_globex', 'globex');
    localStorage.setItem('weldsuite:query-cache:org_globex', globex);
    renderProvider();

    await setUntilPersisted('org_acme', 'tickets', 'tkt_1');
    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).toBe(globex);
  });

  it('drops the legacy shared key', async () => {
    localStorage.setItem('weldsuite:query-cache', persistedEntry('org_acme', 'acme'));
    renderProvider();

    await waitFor(() => expect(localStorage.getItem('weldsuite:query-cache')).toBeNull());
  });

  it('stops writing when the tab switches workspace in place, and restores nothing', async () => {
    localStorage.setItem('weldsuite:query-cache:org_globex', persistedEntry('org_globex', 'globex'));
    const view = renderProvider();
    await setUntilPersisted('org_acme', 'tickets', 'tkt_acme');

    // setActive() in this tab, before the reload that follows it.
    auth.orgId = 'org_globex';
    view.rerender(
      <QueryProvider>
        <div />
      </QueryProvider>,
    );
    act(() => {
      queryClient.setQueryData(['tickets'], ['tkt_fetched_with_globex_token']);
    });
    await sleep(1500);

    expect(localStorage.getItem('weldsuite:query-cache:org_acme')).not.toContain('globex_token');
    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).not.toContain('tkt_');
    expect(queryClient.getQueryData(['owner'])).toBeUndefined();
  });

  it('does not persist without an active workspace', async () => {
    auth.orgId = null;
    renderProvider();
    act(() => {
      queryClient.setQueryData(['me'], 'user');
    });
    await sleep(1500);

    expect(Object.keys(localStorage).filter((k) => k.startsWith('weldsuite:query-cache'))).toEqual([]);
  });

  it('removes every workspace cache when signed out', async () => {
    localStorage.setItem('weldsuite:query-cache:org_acme', persistedEntry('org_acme', 'acme'));
    localStorage.setItem('weldsuite:query-cache:org_globex', persistedEntry('org_globex', 'globex'));
    localStorage.setItem('weldsuite:query-cache-index', '{}');
    auth.isSignedIn = false;
    auth.orgId = null;
    renderProvider();

    await waitFor(() =>
      expect(Object.keys(localStorage).filter((k) => k.startsWith('weldsuite:query-cache'))).toEqual([]),
    );
  });
});
