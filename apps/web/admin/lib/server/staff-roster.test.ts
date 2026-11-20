import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decide, refusal, roleOf, staffIdentity, staffRefusal } from './staff-roster';
import type { StaffSession } from './oidc';
import type { AdminRole } from '../roles';

/**
 * The master database as `staffIdentity` uses it: each `select … limit` answers
 * the next of `selects`, each `update … returning` the next of `returning`,
 * and every `update … set` is recorded.
 */
const fake = vi.hoisted(() => {
  const state = { selects: [] as unknown[][], returning: [] as unknown[][], sets: [] as Record<string, unknown>[], reads: 0 };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.reads += 1;
            return state.selects.shift() ?? [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.sets.push(values);
        const updated = {
          returning: async () => state.returning.shift() ?? [],
          then: (resolve: (value: undefined) => void) => resolve(undefined),
        };
        return { where: () => updated };
      },
    }),
  };
  return { state, db };
});

vi.mock('../db', async () => ({
  masterSchema: await import('@weldsuite/db/schema/master'),
  getMasterDb: () => fake.db,
}));

const STAFF_ORG = 'org-staff';
/** Ann's account in the staff organization: who the console is for. */
const session: StaffSession = { sub: 'sub-ann-staff', email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann', org: STAFF_ORG };
const row = (
  consoleSubject: string | null,
  { role = 'admin', isActive = true }: { role?: AdminRole; isActive?: boolean } = {},
) => ({
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

  it('skips the organization check when none is configured (SEC-019: WeldID\'s separate staff issuer already guarantees it)', () => {
    expect(decide({ ...session, org: '' }, '', row('sub-ann-staff'), undefined)).toEqual({
      row: row('sub-ann-staff'),
      bind: false,
    });
    expect(decide({ ...session, org: null }, '', undefined, row(null))).toEqual({ row: row(null), bind: true });
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

describe('staffIdentity', () => {
  beforeEach(() => {
    fake.state.selects = [];
    fake.state.returning = [];
    fake.state.sets = [];
    fake.state.reads = 0;
  });

  it('lets in the bound staff account and notes the sign-in', async () => {
    fake.state.selects = [[row('sub-ann-staff', { role: 'superadmin' })]];
    await expect(staffIdentity(session, { staffOrgId: STAFF_ORG, signingIn: true })).resolves.toEqual({
      userId: 'sub-ann-staff',
      email: 'ann@weldsuite.test',
      name: 'Ann',
      role: 'superadmin',
      isSuperAdmin: true,
    });
    expect(fake.state.reads).toBe(1);
    expect(Object.keys(fake.state.sets[0]!)).toEqual(['lastLoginAt']);
  });

  it('binds an unbound row to the staff account, never touching user_id', async () => {
    fake.state.selects = [[], [row(null)]];
    fake.state.returning = [[{ email: 'ann@weldsuite.test' }]];
    const identity = await staffIdentity(session, { staffOrgId: STAFF_ORG, signingIn: true });
    expect(identity?.role).toBe('admin');
    expect(fake.state.sets[0]).toMatchObject({ consoleSubject: 'sub-ann-staff', name: 'Ann' });
    expect(fake.state.sets[0]).not.toHaveProperty('userId');
  });

  it('refuses when another sign-in bound the row first', async () => {
    fake.state.selects = [[], [row(null)]];
    fake.state.returning = [[]];
    await expect(staffIdentity(session, { staffOrgId: STAFF_ORG })).resolves.toBeNull();
  });

  it("refuses a removed person's account without looking up the email", async () => {
    fake.state.selects = [[row('sub-ann-staff', { isActive: false })]];
    await expect(staffIdentity(session, { staffOrgId: STAFF_ORG })).resolves.toBeNull();
    expect(fake.state.reads).toBe(1);
    expect(fake.state.sets).toEqual([]);
  });

  it('refuses an account of another organization before reading the roster', async () => {
    await expect(staffIdentity({ ...session, org: 'org-platform' }, { staffOrgId: STAFF_ORG })).resolves.toBeNull();
    expect(fake.state.reads).toBe(0);
  });

  it('lets in any account on the roster when no staff organization is configured (WeldID)', async () => {
    fake.state.selects = [[row('sub-ann-staff', { role: 'superadmin' })]];
    await expect(
      staffIdentity({ ...session, org: null }, { staffOrgId: '', signingIn: true }),
    ).resolves.toEqual({
      userId: 'sub-ann-staff',
      email: 'ann@weldsuite.test',
      name: 'Ann',
      role: 'superadmin',
      isSuperAdmin: true,
    });
  });

  it('refuses a row whose role is unknown', async () => {
    fake.state.selects = [[{ ...row('sub-ann-staff'), role: 'owner' }]];
    await expect(staffIdentity(session, { staffOrgId: STAFF_ORG })).resolves.toBeNull();
  });
});

describe('refusal', () => {
  it('names an account outside the staff organization, only when one is configured', () => {
    expect(refusal({ ...session, org: 'org-platform' }, STAFF_ORG, undefined, row(null))).toBe(
      'an account outside the staff organization',
    );
    expect(refusal({ ...session, org: null }, '', undefined, undefined)).not.toContain('staff organization');
  });

  it("names a removed person's account, and a bound row with an unknown role", () => {
    expect(refusal(session, STAFF_ORG, row('sub-ann-staff', { isActive: false }), undefined)).toBe(
      'an account removed from the staff list',
    );
    expect(refusal(session, STAFF_ORG, { ...row('sub-ann-staff'), role: 'owner' as AdminRole }, undefined)).toBe(
      'a staff-list row with an unknown role (owner)',
    );
  });

  it('names an email that is not on the list, removed from it, or not verified', () => {
    expect(refusal({ ...session, email: null }, STAFF_ORG, undefined, undefined)).toContain('gave no email');
    expect(refusal(session, STAFF_ORG, undefined, undefined)).toBe('an email that is not on the staff list');
    expect(refusal(session, STAFF_ORG, undefined, row(null, { isActive: false }))).toBe(
      'an email removed from the staff list',
    );
    expect(refusal({ ...session, emailVerified: false }, STAFF_ORG, undefined, row(null))).toBe(
      'an email the identity provider does not call verified',
    );
  });

  // EU test, 2026-11-19: the row was still bound to the person's Zitadel
  // account when they signed in with their WeldID staff account.
  it('names a row bound to another account, and how to bind it again', () => {
    const why = refusal({ ...session, org: null }, '', undefined, row('sub-ann-zitadel'));
    expect(why).toContain('bound to another account');
    expect(why).toContain('console_subject');
  });

  it('names an unknown role on the email row, and a row another sign-in bound first', () => {
    expect(refusal(session, STAFF_ORG, undefined, { ...row(null), role: 'owner' as AdminRole })).toBe(
      'a staff-list row with an unknown role (owner)',
    );
    expect(refusal(session, STAFF_ORG, undefined, row(null))).toBe(
      'an email whose staff-list row another sign-in bound first',
    );
  });
});

describe('staffRefusal', () => {
  beforeEach(() => {
    fake.state.selects = [];
    fake.state.reads = 0;
  });

  it('looks up the email row whether active or not', async () => {
    fake.state.selects = [[], [row('sub-ann-zitadel')]];
    await expect(staffRefusal({ ...session, org: null }, { staffOrgId: '' })).resolves.toContain('bound to another account');
    expect(fake.state.reads).toBe(2);
  });

  it('stops at the account bound to a removed row', async () => {
    fake.state.selects = [[row('sub-ann-staff', { isActive: false })]];
    await expect(staffRefusal(session, { staffOrgId: STAFF_ORG })).resolves.toBe('an account removed from the staff list');
    expect(fake.state.reads).toBe(1);
  });

  it('names an account outside the staff organization without reading the roster', async () => {
    await expect(staffRefusal({ ...session, org: 'org-platform' }, { staffOrgId: STAFF_ORG })).resolves.toBe(
      'an account outside the staff organization',
    );
    expect(fake.state.reads).toBe(0);
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
