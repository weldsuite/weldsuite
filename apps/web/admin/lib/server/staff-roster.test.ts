import { describe, expect, it } from 'vitest';
import { decide, roleOf } from './staff-roster';
import type { StaffSession } from './oidc';

const session: StaffSession = { sub: 'sub-ann', email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann' };
const row = (userId: string | null, role = 'admin' as const) => ({ email: 'ann@weldsuite.test', name: null, role, userId });

describe('decide', () => {
  it('lets in the row bound to the subject', () => {
    expect(decide(session, row('sub-ann'), undefined)).toEqual({ row: row('sub-ann'), bind: false });
  });

  it('binds an unbound row on a verified email', () => {
    expect(decide(session, undefined, row(null))).toEqual({ row: row(null), bind: true });
  });

  it('refuses an unverified email', () => {
    expect(decide({ ...session, emailVerified: false }, undefined, row(null))).toBeNull();
  });

  it('refuses a row already bound to another account with the same email', () => {
    expect(decide(session, undefined, row('sub-someone-else'))).toBeNull();
  });

  it('refuses someone with no row', () => {
    expect(decide(session, undefined, undefined)).toBeNull();
    expect(decide({ ...session, email: null }, undefined, row(null))).toBeNull();
  });
});

describe('roleOf', () => {
  it('maps the roster roles and nothing else', () => {
    expect(roleOf('superadmin')).toBe('superadmin');
    expect(roleOf('admin')).toBe('admin');
    expect(roleOf('viewer')).toBe('viewer');
    expect(roleOf('owner')).toBeNull();
    expect(roleOf('')).toBeNull();
  });
});
