/**
 * Which values the admin identity accepts as an email address. The pattern is
 * deliberately loose (one `@`, a dot in the domain, no whitespace); these tests
 * pin exactly which strings pass, against the regular expression the check was
 * first written as, so rewriting it without backtracking cannot change an answer.
 */

import { describe, expect, it } from 'vitest';
import { isEmailShaped, parseAdminActor } from './admin-auth';

/** The expression the check was first written as; super-linear on a long run of dots. */
const LEGACY_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function acceptedByParse(candidate: string): boolean {
  return parseAdminActor(candidate, undefined, 'superadmin') !== null;
}

/** What `parseAdminActor` does to the address before it looks at it. */
function legacyAccepts(candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  return Boolean(normalized) && normalized.length <= 255 && LEGACY_EMAIL.test(normalized);
}

describe('admin email address check', () => {
  it('accepts an address with one @ and a dot in the domain', () => {
    for (const email of ['ops@weldsuite.org', 'a@b.c', 'a.b+c@sub.example.co.uk', 'x@.y.z', 'x@y..z', 'x@y.z.', 'x@a.b']) {
      expect(acceptedByParse(email)).toBe(true);
    }
  });

  it('rejects what is not shaped like an address', () => {
    for (const email of [
      '',
      '   ',
      'ops',
      'ops@',
      '@weldsuite.org',
      'ops@weldsuite',
      'ops@.org',
      'ops@weldsuite.',
      'ops@@weldsuite.org',
      'o@ps@weldsuite.org',
      'ops @weldsuite.org',
      'ops@weld suite.org',
      'ops@weldsuite.o rg',
      'ops@weldsuite.org x',
      `${'a'.repeat(251)}@b.cd`, // 256 characters: over the cap
    ]) {
      expect(acceptedByParse(email)).toBe(false);
    }
  });

  it('agrees with the expression it replaced on every combination of up to six pieces', () => {
    const pieces = ['a', 'Ab', '.', '@', ' ', ' ', '\n'];
    let layer: string[] = [''];
    let checked = 0;
    for (let n = 0; n < 6; n++) {
      const next: string[] = [];
      for (const prefix of layer) for (const piece of pieces) next.push(prefix + piece);
      for (const candidate of next) {
        expect(acceptedByParse(candidate), JSON.stringify(candidate)).toBe(legacyAccepts(candidate));
        checked += 1;
      }
      layer = next;
    }
    expect(checked).toBeGreaterThan(100_000);
  });
});

describe('isEmailShaped', () => {
  it('agrees with the expression it replaced on every combination of up to seven pieces', () => {
    const pieces = ['a', '.', '@', ' ', ' ', '\t'];
    let layer: string[] = [''];
    let checked = 0;
    for (let n = 0; n < 7; n++) {
      const next: string[] = [];
      for (const prefix of layer) for (const piece of pieces) next.push(prefix + piece);
      for (const candidate of next) {
        expect(isEmailShaped(candidate), JSON.stringify(candidate)).toBe(LEGACY_EMAIL.test(candidate));
        checked += 1;
      }
      layer = next;
    }
    expect(checked).toBeGreaterThan(300_000);
  });

  it('answers at once for the inputs that make the old expression backtrack', () => {
    const n = 200_000;
    expect(isEmailShaped(`a@${'.'.repeat(n)} `)).toBe(false); // old: quadratic before failing on the space
    expect(isEmailShaped(`a@${'b'.repeat(n)}`)).toBe(false); // no dot to split on
    expect(isEmailShaped(`${'a'.repeat(n)}@`)).toBe(false);
    expect(isEmailShaped('a'.repeat(n))).toBe(false);
    expect(isEmailShaped(`a@${'b.'.repeat(n)}`)).toBe(true);
    expect(isEmailShaped(`a@${'.'.repeat(n)}`)).toBe(true); // M and R may themselves be dots
    expect(isEmailShaped(`a@b${'.'.repeat(n)}`)).toBe(true);
    expect(isEmailShaped(`a@${'@'.repeat(n)}`)).toBe(false);
  });
});
