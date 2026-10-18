import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client/client';
import { roleNameProblem, roleNameProblemFromError } from './role-name';
import { extraActionLabel, humanizeAction } from './app-permission-matrix';

const roles = [
  { id: 'role_owner', name: 'Owner' },
  { id: 'role_sales', name: 'Sales' },
];

describe('roleNameProblem', () => {
  it('flags system names, trimmed and case-insensitive', () => {
    expect(roleNameProblem('Owner', [])).toBe('reserved');
    expect(roleNameProblem('  admin ', [])).toBe('reserved');
    expect(roleNameProblem('VIEWER', [])).toBe('reserved');
  });

  it('flags an existing name, but not the role being renamed', () => {
    expect(roleNameProblem(' sales', roles)).toBe('duplicate');
    expect(roleNameProblem('Sales', roles, 'role_sales')).toBeNull();
    expect(roleNameProblem('Support', roles)).toBeNull();
    expect(roleNameProblem('   ', roles)).toBeNull();
  });
});

describe('roleNameProblemFromError', () => {
  it('reads the reason from the API error body', () => {
    const body = { error: { code: 'BAD_REQUEST', message: 'x', details: { field: 'name', reason: 'reserved' } } };
    expect(roleNameProblemFromError(new ApiError('x', 400, body))).toBe('reserved');
    expect(roleNameProblemFromError(new ApiError('x', 409, {}))).toBe('duplicate');
    expect(roleNameProblemFromError(new ApiError('x', 500, {}))).toBeNull();
    expect(roleNameProblemFromError(new Error('offline'))).toBeNull();
  });
});

describe('extraActionLabel', () => {
  it('uses the translation when there is one', () => {
    const t = (key: string) => (key === 'settings.roles.extraActions.inviteExternal' ? 'Invite external guests' : key);
    expect(extraActionLabel('invite_external', t)).toBe('Invite external guests');
  });

  it('humanises an action without a translation instead of showing the raw key', () => {
    const t = (key: string) => key;
    expect(extraActionLabel('invite_external', t)).toBe('Invite external');
    expect(humanizeAction('scope:all')).toBe('Scope all');
    expect(humanizeAction('edit-self')).toBe('Edit self');
  });
});
