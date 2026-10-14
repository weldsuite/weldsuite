/**
 * Members removed in WeldSuite but still listed by Clerk must not take a seat.
 * The team-members DELETE route used to address Clerk by membership id, which
 * Clerk 404s, so removed members stayed in the Clerk organization.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { pickRemovedMemberships, removeClerkMembership, type ClerkMembershipListItem } from './member-count';

function membership(userId: string, email: string): ClerkMembershipListItem {
  return {
    id: `orgmem_${userId}`,
    role: 'org:member',
    created_at: 0,
    public_user_data: { user_id: userId, first_name: null, last_name: null, identifier: email },
  };
}

const removedAt = new Date('2026-10-01');

describe('pickRemovedMemberships', () => {
  it('picks a membership whose only member row is soft-deleted', () => {
    const memberships = [membership('user_a', 'a@x.com'), membership('user_b', 'b@x.com')];
    const rows = [
      { userId: 'user_a', email: 'a@x.com', deletedAt: null },
      { userId: 'user_b', email: 'b@x.com', deletedAt: removedAt },
    ];
    expect(pickRemovedMemberships(memberships, rows).map((m) => m.id)).toEqual(['orgmem_user_b']);
  });

  it('keeps a membership when the user also has a live row', () => {
    const rows = [
      { userId: 'user_b', email: 'b@x.com', deletedAt: removedAt },
      { userId: 'user_b', email: 'b@x.com', deletedAt: null },
    ];
    expect(pickRemovedMemberships([membership('user_b', 'b@x.com')], rows)).toEqual([]);
  });

  it('keeps a membership when the email has a live (re-invite) row', () => {
    const rows = [
      { userId: 'user_b', email: 'b@x.com', deletedAt: removedAt },
      { userId: 'invited_b@x.com', email: 'B@x.com', deletedAt: null },
    ];
    expect(pickRemovedMemberships([membership('user_b', 'b@x.com')], rows)).toEqual([]);
  });

  it('keeps a membership with no member row at all (webhook not landed yet)', () => {
    expect(pickRemovedMemberships([membership('user_c', 'c@x.com')], [])).toEqual([]);
  });
});

describe('removeClerkMembership', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deletes by user id, not membership id', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await removeClerkMembership('sk', 'org_1', 'user_b')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/organizations/org_1/memberships/user_b',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('treats 404 as already removed and other errors as failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await removeClerkMembership('sk', 'org_1', 'user_b')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await removeClerkMembership('sk', 'org_1', 'user_b')).toBe(false);
  });
});
