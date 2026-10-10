/**
 * What the portal sends on the wire: the partner header on portal calls, none
 * on `/partner/me`, and the Idempotency-Key on a credit grant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePartnerClients } from './partner-api';
import { resolveMembership } from './partner-context';
import { getSelectedPartnerId, setSelectedPartnerId } from './selected-partner';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: () => Promise.resolve('jwt_token') }),
}));

const fetchMock = vi.fn();

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe('usePartnerClients', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends X-Partner-Id and the Clerk token on portal calls', async () => {
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await result.current.portal.listRequests();
    const { url, headers } = lastCall();
    expect(url).toMatch(/\/api\/partner\/requests$/);
    expect(headers['X-Partner-Id']).toBe('ptr_42');
    expect(headers.Authorization).toBe('Bearer jwt_token');
  });

  it('does not send a partner id when asking who the caller is', async () => {
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await result.current.account.me();
    const { url, headers } = lastCall();
    expect(url).toMatch(/\/api\/partner\/me$/);
    expect(headers['X-Partner-Id']).toBeUndefined();
  });

  it('adds the Idempotency-Key to a credit grant, next to the partner id', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { newBalance: 10, amount: 5, charge: '0.05' } }), { status: 200 }),
    );
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await result.current.portalWith({ 'Idempotency-Key': 'key-123' }).grantCredits('ws_1', { credits: 5 });
    const { url, init, headers } = lastCall();
    expect(url).toMatch(/\/api\/partner\/workspaces\/ws_1\/credits$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ credits: 5 }));
    expect(headers['Idempotency-Key']).toBe('key-123');
    expect(headers['X-Partner-Id']).toBe('ptr_42');
  });

  it('does not leak the Idempotency-Key into later calls', async () => {
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await result.current.portalWith({ 'Idempotency-Key': 'key-123' }).listRequests();
    await result.current.portal.listRequests();
    expect(lastCall().headers['Idempotency-Key']).toBeUndefined();
  });

  it('filters and pages the workspace list on the server', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } }), {
        status: 200,
      }),
    );
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await result.current.portal.listWorkspaces({ q: 'acme', limit: 50, cursor: '50' });
    const { url } = lastCall();
    expect(url).toContain('/api/partner/workspaces?');
    expect(url).toContain('q=acme');
    expect(url).toContain('limit=50');
    expect(url).toContain('cursor=50');
  });

  it('reads the CSV as text', async () => {
    fetchMock.mockResolvedValue(new Response('workspace,due\nAcme,300.00\n', { status: 200 }));
    const { result } = renderHook(() => usePartnerClients('ptr_42'));
    await expect(result.current.portal.statementCsv('current')).resolves.toBe('workspace,due\nAcme,300.00\n');
    expect(lastCall().url).toMatch(/\/api\/partner\/statements\/current\/csv$/);
  });
});

describe('resolveMembership', () => {
  const memberships = [
    { partnerId: 'ptr_a', partnerName: 'A', role: 'owner' as const, status: 'active' as const },
    { partnerId: 'ptr_b', partnerName: 'B', role: 'viewer' as const, status: 'past_due' as const },
  ];

  it('uses the remembered partner while the user still belongs to it', () => {
    expect(resolveMembership(memberships, 'ptr_b')?.partnerId).toBe('ptr_b');
  });

  it('falls back to the first partner when the remembered one is gone or unset', () => {
    expect(resolveMembership(memberships, 'ptr_gone')?.partnerId).toBe('ptr_a');
    expect(resolveMembership(memberships, null)?.partnerId).toBe('ptr_a');
  });

  it('is null for a user with no memberships', () => {
    expect(resolveMembership([], 'ptr_a')).toBeNull();
  });
});

describe('selected partner store', () => {
  it('remembers the choice in localStorage and tells subscribers', () => {
    setSelectedPartnerId('ptr_b');
    expect(getSelectedPartnerId()).toBe('ptr_b');
    expect(window.localStorage.getItem('weldsuite:partner-id')).toBe('ptr_b');
    setSelectedPartnerId(null);
    expect(window.localStorage.getItem('weldsuite:partner-id')).toBeNull();
  });
});
