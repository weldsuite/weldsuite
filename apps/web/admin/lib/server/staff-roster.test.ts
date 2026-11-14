import { describe, expect, it } from 'vitest';
import { decide, roleOf } from './staff-roster';
import type { StaffSession } from './oidc';

const STAFF_ORG = 'org-staff';
/** Ann's account in the staff organization: who the console is for. */
const session: StaffSession = { sub: 'sub-ann-staff', email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann', org: STAFF_ORG };
const row = (consoleSubject: string | null, { role = 'admin' as const, isActive = true } = {}) => ({
  email: 'ann@weldsuite.test',
  name: null,
  role,
  isActive,
  consoleSubject,
});

describe('decide', () => {
  it('lets in the row bound to the account', () => {
    expect(decide(session, STAFF_ORG, row('sub-ann-staff'), undefined)).toEqual({ row: row('sub-ann-staff'), bind: false });
  });

  it('binds an unbound row on a verified email', () => {
    expect(decide(session, STAFF_ORG, undefined, row(null))).toEqual({ row: row(null), bind: true });
  });

  // ADR SEC-018: `staff add` names the platform account in `user_id`, which
  // the console no longer reads, so a row added for someone who also uses the
  // platform is still unbound for the console and binds their staff account.
  it("binds the staff account of a row whose user_id names the person's platform account", () => {
    const added = { ...row(null), userId: 'sub-ann-platform' };
    expect(decide(session, STAFF_ORG, undefined, added)).toEqual({ row: added, bind: true });
  });

  it('refuses an account outside the staff organization, a platform account included', () => {
    expect(decide({ ...session, org: 'org-platform' }, STAFF_ORG, undefined, row(null))).toBeNull();
    expect(decide({ ...session, org: 'org-platform' }, STAFF_ORG, row('sub-ann-staff'), undefined)).toBeNull();
  });

  it('refuses a session without an organization (sealed before the check)', () => {
    const { org: _org, ...old } = session;
    expect(decide(old, STAFF_ORG, row('sub-ann-staff'), undefined)).toBeNull();
    expect(decide({ ...session, org: null }, STAFF_ORG, row('sub-ann-staff'), undefined)).toBeNull();
  });

  it('refuses everyone when no staff organization is configured', () => {
    expect(decide({ ...session, org: '' }, '', row('sub-ann-staff'), undefined)).toBeNull();
  });

  it('refuses an unverified email', () => {
    expect(decide({ ...session, emailVerified: false }, STAFF_ORG, undefined, row(null))).toBeNull();
  });

  it('refuses a row already bound to another account with the same email', () => {
    expect(decide(session, STAFF_ORG, undefined, row('sub-someone-else'))).toBeNull();
  });

  it("keeps a removed person's account out, even under another email", () => {
    const removed = row('sub-ann-staff', { isActive: false });
    expect(decide(session, STAFF_ORG, removed, undefined)).toBeNull();
    expect(decide({ ...session, email: 'ann.new@weldsuite.test' }, STAFF_ORG, removed, row(null))).toBeNull();
  });

  it('refuses an inactive row found by email', () => {
    expect(decide(session, STAFF_ORG, undefined, row(null, { isActive: false }))).toBeNull();
  });

  it('refuses someone with no row', () => {
    expect(decide(session, STAFF_ORG, undefined, undefined)).toBeNull();
    expect(decide({ ...session, email: null }, STAFF_ORG, undefined, row(null))).toBeNull();
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
