/**
 * Unit tests for keeping Clerk's `max_allowed_memberships` in step with the
 * plan before an internal invite, and for counting the pending invitations
 * that take a seat. Clerk is faked at the fetch level.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../types';
import {
  alignClerkCapWithPlan,
  clerkCapForPlan,
  countPendingSeatInvitations,
} from './clerk-seat-cap';

const env = { CLERK_SECRET_KEY: 'sk_test_fake' } as Env;
const ORG = 'org_test';

const seat = { public_metadata: {} };
const guest = { public_metadata: { member_type: 'EXTERNAL_GUEST' } };

type FakeOrg = { cap: number | null; members: object[]; invitations: object[] };
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A Clerk Backend API stand-in serving one organization, paginated like Clerk. */
function fakeClerk(org: FakeOrg): Mock<FetchFn> {
  return vi.fn<FetchFn>(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'PATCH') return json({ id: ORG });
    const limit = Number(url.searchParams.get('limit') ?? 10);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const page = (items: object[]) =>
      json({ data: items.slice(offset, offset + limit), total_count: items.length });
    if (url.pathname.endsWith('/memberships')) return page(org.members);
    if (url.pathname.endsWith('/invitations')) return page(org.invitations);
    return json({ id: ORG, max_allowed_memberships: org.cap });
  });
}

const originalFetch = globalThis.fetch;
let fetchMock: Mock<FetchFn>;

function useFetch(mock: Mock<FetchFn>) {
  fetchMock = mock;
  globalThis.fetch = mock as unknown as typeof fetch;
}

const useClerk = (org: FakeOrg) => useFetch(fakeClerk(org));
const clerkDown = () => useFetch(vi.fn<FetchFn>(async () => json({ errors: [] }, 500)));

/** The `max_allowed_memberships` values PATCHed to Clerk, in order. */
function patchedCaps(): Array<number | null> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)).max_allowed_memberships);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('clerkCapForPlan', () => {
  it('leaves an organization without a cap alone', () => {
    expect(clerkCapForPlan(null, 6, 0)).toBeNull();
    expect(clerkCapForPlan(0, 6, 0)).toBeNull();
  });

  it('clears the cap when the plan has no seat limit', () => {
    expect(clerkCapForPlan(1, null, 0)).toBe(0);
  });

  it("raises a stale cap to the plan's seats plus the guests' slots", () => {
    expect(clerkCapForPlan(1, 6, 0)).toBe(6);
    expect(clerkCapForPlan(1, 6, 2)).toBe(8);
  });

  it('leaves a cap that already fits, and never tightens one', () => {
    expect(clerkCapForPlan(8, 6, 2)).toBeNull();
    expect(clerkCapForPlan(25, 6, 0)).toBeNull();
  });
});

describe('countPendingSeatInvitations', () => {
  it('counts pending invitations across pages, guests excluded', async () => {
    useClerk({
      cap: null,
      members: [],
      invitations: [...Array.from({ length: 150 }, () => seat), guest, guest, guest],
    });

    expect(await countPendingSeatInvitations(env, ORG)).toBe(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=pending');
  });

  it('returns null when Clerk cannot be read', async () => {
    clerkDown();

    expect(await countPendingSeatInvitations(env, ORG)).toBeNull();
  });
});

describe('alignClerkCapWithPlan', () => {
  it("raises Free's leftover one-seat cap to the plan's seats", async () => {
    useClerk({ cap: 1, members: [seat], invitations: [] });

    await alignClerkCapWithPlan(env, ORG, 6);

    expect(patchedCaps()).toEqual([6]);
  });

  it('keeps room for the guests, who count against the cap but not the plan', async () => {
    useClerk({ cap: 3, members: [seat, guest], invitations: [guest] });

    await alignClerkCapWithPlan(env, ORG, 3);

    expect(patchedCaps()).toEqual([5]);
  });

  it('clears the cap for a plan without a seat limit, without listing anyone', async () => {
    useClerk({ cap: 1, members: [seat], invitations: [] });

    await alignClerkCapWithPlan(env, ORG, null);

    expect(patchedCaps()).toEqual([null]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // read org, PATCH
  });

  it('does nothing when Clerk has no cap', async () => {
    useClerk({ cap: null, members: [seat], invitations: [] });

    await alignClerkCapWithPlan(env, ORG, 6);

    expect(patchedCaps()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the cap already matches the plan', async () => {
    useClerk({ cap: 6, members: [seat], invitations: [seat] });

    await alignClerkCapWithPlan(env, ORG, 6);

    expect(patchedCaps()).toEqual([]);
  });

  it('gives up quietly when Clerk cannot be read', async () => {
    clerkDown();

    await expect(alignClerkCapWithPlan(env, ORG, 6)).resolves.toBeUndefined();
    expect(patchedCaps()).toEqual([]);
  });
});
