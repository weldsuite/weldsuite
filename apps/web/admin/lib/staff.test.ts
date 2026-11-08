import { describe, expect, it } from 'vitest';
import { keepsASuperadmin, mayChangeStaff, normalizeStaffEmail, parseStaffRole } from './staff';

describe('normalizeStaffEmail', () => {
  it('lowercases and trims an address', () => {
    expect(normalizeStaffEmail('  Ann@WeldSuite.ORG ')).toBe('ann@weldsuite.org');
  });

  it('refuses what is not an address', () => {
    for (const value of ['', 'ann', 'ann@', '@weldsuite.org', 'ann@weldsuite', 'a b@weldsuite.org', 'a@b@weldsuite.org']) {
      expect(normalizeStaffEmail(value)).toBeNull();
    }
  });
});

describe('parseStaffRole', () => {
  it('takes the three roles and nothing else', () => {
    expect(parseStaffRole('Superadmin')).toBe('superadmin');
    expect(parseStaffRole('viewer')).toBe('viewer');
    expect(parseStaffRole('owner')).toBeNull();
  });
});

describe('mayChangeStaff', () => {
  it('is for superadmins only', () => {
    expect(mayChangeStaff('superadmin')).toBe(true);
    expect(mayChangeStaff('admin')).toBe(false);
    expect(mayChangeStaff('viewer')).toBe(false);
  });
});

describe('keepsASuperadmin', () => {
  const superadmin = { role: 'superadmin' as const, isActive: true };

  it('refuses to remove or demote the last active superadmin', () => {
    expect(keepsASuperadmin(superadmin, false, 1)).toBe(false);
  });

  it('allows it while another superadmin stays', () => {
    expect(keepsASuperadmin(superadmin, false, 2)).toBe(true);
  });

  it('allows changes that take no superadmin away', () => {
    expect(keepsASuperadmin(superadmin, true, 1)).toBe(true);
    expect(keepsASuperadmin({ role: 'admin', isActive: true }, false, 1)).toBe(true);
    expect(keepsASuperadmin({ role: 'superadmin', isActive: false }, false, 1)).toBe(true);
    expect(keepsASuperadmin(null, false, 1)).toBe(true);
  });
});
