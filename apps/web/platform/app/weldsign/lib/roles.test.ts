import { describe, expect, it } from 'vitest';
import { parseOptionalEmail, roleNameTaken, rolesInOrder } from './roles';

const roles = [
  { id: 'sgr_1', roleName: 'Client' },
  { id: 'sgr_2', roleName: 'Director' },
  { id: 'sgr_3', roleName: null },
];

describe('roleNameTaken', () => {
  it('ignores case and surrounding spaces', () => {
    expect(roleNameTaken(roles, 'client')).toBe(true);
    expect(roleNameTaken(roles, '  DIRECTOR ')).toBe(true);
    expect(roleNameTaken(roles, 'Witness')).toBe(false);
  });

  it('lets a role keep its own name', () => {
    expect(roleNameTaken(roles, 'Client', 'sgr_1')).toBe(false);
    expect(roleNameTaken(roles, 'Client', 'sgr_2')).toBe(true);
  });

  it('does not take a new name for the name of a role without one', () => {
    expect(roleNameTaken(roles, 'Witness', 'sgr_3')).toBe(false);
  });
});

describe('parseOptionalEmail', () => {
  it('reads a blank field as no default', () => {
    expect(parseOptionalEmail('')).toBeNull();
    expect(parseOptionalEmail('   ')).toBeNull();
  });

  it('lower-cases a valid address and trims it', () => {
    expect(parseOptionalEmail(' Ann@Example.COM ')).toBe('ann@example.com');
  });

  it('refuses anything else', () => {
    expect(parseOptionalEmail('ann')).toBeUndefined();
    expect(parseOptionalEmail('ann@')).toBeUndefined();
  });
});

describe('rolesInOrder', () => {
  it('sorts by routing order and keeps the order the server gave for equal ones', () => {
    const list = [
      { id: 'c', routingOrder: 2 },
      { id: 'a', routingOrder: 1 },
      { id: 'd', routingOrder: 2 },
      { id: 'b', routingOrder: 1 },
    ];
    expect(rolesInOrder(list).map((role) => role.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not change the list it is given', () => {
    const list = [{ routingOrder: 2 }, { routingOrder: 1 }];
    rolesInOrder(list);
    expect(list.map((role) => role.routingOrder)).toEqual([2, 1]);
  });
});
