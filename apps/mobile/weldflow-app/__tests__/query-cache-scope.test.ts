import { cacheActionFor, INITIAL_CACHE_OWNER } from '@/lib/query-cache-scope';

const owner = (userId: string | null, orgId: string | null = null) => ({ userId, orgId });

describe('cacheActionFor', () => {
  it('leaves the cache alone on app start', () => {
    expect(cacheActionFor(INITIAL_CACHE_OWNER, owner('user_a', 'org_1'))).toBeNull();
    expect(cacheActionFor(INITIAL_CACHE_OWNER, owner(null))).toBeNull();
  });

  it('clears on sign-out', () => {
    expect(cacheActionFor(owner('user_a', 'org_1'), owner(null))).toBe('clear');
  });

  it('clears when another user signs in without passing through signed-out', () => {
    expect(cacheActionFor(owner('user_a', 'org_1'), owner('user_b', 'org_2'))).toBe('clear');
  });

  it('resets when the same user switches workspace', () => {
    expect(cacheActionFor(owner('user_a', 'org_1'), owner('user_a', 'org_2'))).toBe('reset');
  });

  it('does nothing when the first workspace is picked after sign-in', () => {
    expect(cacheActionFor(owner('user_a'), owner('user_a', 'org_1'))).toBeNull();
  });

  it('does nothing when nothing changed', () => {
    expect(cacheActionFor(owner('user_a', 'org_1'), owner('user_a', 'org_1'))).toBeNull();
  });
});
