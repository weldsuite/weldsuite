import { describe, expect, it } from 'vitest';
import { normalizePortalSlug, PORTAL_SLUG_PATTERN } from './portal-slug';

describe('normalizePortalSlug', () => {
  it.each([
    ['acme', 'acme'],
    ['acme-corp', 'acme-corp'],
    ['acme-corp-1704067200', 'acme-corp-1704067200'],
    ['a1', 'a1'],
    ['  ACME  ', 'acme'],
    ['x'.repeat(100), 'x'.repeat(100)],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizePortalSlug(raw)).toBe(expected);
  });

  it.each([
    ['%'],
    ['a%'],
    ['%a'],
    ['_'],
    ['ac_me'],
    ['acme\\'],
    ['\\%'],
    ['acme%25'],
    ['acme corp'],
    ['acme.org'],
    ['acme/corp'],
    ['acme?x=1'],
    ["acme'--"],
    ['ac\nme'],
    ['acme\u0000'],
    ['ünïcode'],
    ['ａｃｍｅ'],
    ['x'.repeat(101)],
    [''],
    ['   '],
  ])('rejects %j', (raw) => {
    expect(normalizePortalSlug(raw)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizePortalSlug(undefined)).toBeNull();
    expect(normalizePortalSlug(null)).toBeNull();
  });

  it('never accepts a LIKE metacharacter, whatever the other characters are', () => {
    expect(PORTAL_SLUG_PATTERN.test('abc%')).toBe(false);
    for (const ch of ['%', '_', '\\']) {
      expect(normalizePortalSlug(`acme${ch}`)).toBeNull();
      expect(normalizePortalSlug(`${ch}acme`)).toBeNull();
      expect(normalizePortalSlug(`ac${ch}me`)).toBeNull();
    }
  });
});
