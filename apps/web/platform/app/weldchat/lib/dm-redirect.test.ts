import { describe, expect, it } from 'vitest';
import { dmRedirectTarget } from './dm-redirect';

describe('dmRedirectTarget', () => {
  it('goes to the other member for a 1:1 DM', () => {
    expect(dmRedirectTarget([{ userId: 'me' }, { userId: 'zed' }], 'me')).toEqual({ kind: 'dm', userId: 'zed' });
    expect(dmRedirectTarget([{ userId: 'zed' }, { userId: 'me' }], 'me')).toEqual({ kind: 'dm', userId: 'zed' });
  });

  it('goes to the caller own DM page for a self-DM', () => {
    expect(dmRedirectTarget([{ userId: 'me' }], 'me')).toEqual({ kind: 'dm', userId: 'me' });
    expect(dmRedirectTarget([{ userId: 'me' }, { userId: 'me' }], 'me')).toEqual({ kind: 'dm', userId: 'me' });
  });

  it('goes to the group route with more than one other member', () => {
    expect(dmRedirectTarget([{ userId: 'me' }, { userId: 'a' }, { userId: 'b' }], 'me')).toEqual({ kind: 'group' });
  });

  it('falls back to the group route when the members are unknown', () => {
    expect(dmRedirectTarget(undefined, 'me')).toEqual({ kind: 'group' });
    expect(dmRedirectTarget([], 'me')).toEqual({ kind: 'group' });
    expect(dmRedirectTarget([{ userId: null }, {}], 'me')).toEqual({ kind: 'group' });
  });
});
