import { describe, expect, it } from 'vitest';
import { pickWarmMailAccountId, resolveMailLandingPath } from './landing-redirect';
import { UNIFIED_ACCOUNT } from './mail-preferences';

const acc1 = { id: 'macc_1', isDefault: true };
const acc2 = { id: 'macc_2', isDefault: false };

describe('resolveMailLandingPath', () => {
  it('is null when accounts are not cached yet', () => {
    expect(resolveMailLandingPath(undefined, {})).toBeNull();
  });

  it('is null when preferences are not cached yet', () => {
    expect(resolveMailLandingPath([acc1], undefined)).toBeNull();
  });

  it('goes to setup with no accounts', () => {
    expect(resolveMailLandingPath([], {})).toBe('/weldmail/setup');
  });

  it('prefers the pinned default account', () => {
    expect(
      resolveMailLandingPath([acc1, acc2], { mailDefaultAccountId: 'macc_2', mailLastAccountId: 'macc_1' }),
    ).toBe('/weldmail/macc_2/inbox');
  });

  it('falls back to the last-opened account', () => {
    expect(resolveMailLandingPath([acc1, acc2], { mailLastAccountId: 'macc_2' })).toBe('/weldmail/macc_2/inbox');
  });

  it('resolves the unified sentinel to the unified inbox with 2+ accounts', () => {
    expect(resolveMailLandingPath([acc1, acc2], { mailLastAccountId: UNIFIED_ACCOUNT })).toBe(
      '/weldmail/unified/inbox',
    );
  });

  it('ignores the unified sentinel with a single account', () => {
    expect(resolveMailLandingPath([acc1], { mailLastAccountId: UNIFIED_ACCOUNT })).toBe('/weldmail/macc_1/inbox');
  });

  it('ignores a preference pointing at an account the user no longer has', () => {
    expect(resolveMailLandingPath([acc1, acc2], { mailDefaultAccountId: 'macc_gone' })).toBe(
      '/weldmail/unified/inbox',
    );
  });

  it('defaults to the unified inbox with no preference and 2+ accounts', () => {
    expect(resolveMailLandingPath([acc1, acc2], {})).toBe('/weldmail/unified/inbox');
  });

  it('defaults to the workspace default account with no preference and one account', () => {
    expect(resolveMailLandingPath([{ id: 'macc_3', isDefault: false }], {})).toBe('/weldmail/macc_3/inbox');
  });
});

describe('pickWarmMailAccountId', () => {
  it('is undefined with no accounts', () => {
    expect(pickWarmMailAccountId([], {})).toBeUndefined();
    expect(pickWarmMailAccountId(undefined, {})).toBeUndefined();
  });

  it('prefers the pinned default account', () => {
    expect(pickWarmMailAccountId([acc1, acc2], { mailDefaultAccountId: 'macc_2' })).toBe('macc_2');
  });

  it('falls back to the last-opened account', () => {
    expect(pickWarmMailAccountId([acc1, acc2], { mailLastAccountId: 'macc_2' })).toBe('macc_2');
  });

  it('treats the unified sentinel as no preference — there is no single mailbox to warm for it', () => {
    expect(pickWarmMailAccountId([acc1, acc2], { mailLastAccountId: UNIFIED_ACCOUNT })).toBe(acc1.id);
  });

  it('ignores a preference pointing at an account the user no longer has', () => {
    expect(pickWarmMailAccountId([acc1, acc2], { mailDefaultAccountId: 'macc_gone' })).toBe(acc1.id);
  });

  it('defaults to the workspace default account with no preference', () => {
    expect(pickWarmMailAccountId([acc1, acc2], {})).toBe(acc1.id);
  });

  it('defaults to the first account when none is marked default', () => {
    expect(pickWarmMailAccountId([acc2], {})).toBe(acc2.id);
  });
});
