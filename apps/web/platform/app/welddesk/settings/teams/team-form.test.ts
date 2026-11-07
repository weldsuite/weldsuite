import { describe, expect, it } from 'vitest';
import type { DeskTeam, DeskTeamMember } from '@/hooks/queries/use-desk-routing-queries';
import { emptyTeamValues, newEscalationRule, teamToValues, validateTeamValues, valuesToTeamInput } from './team-form';

const members: DeskTeamMember[] = [
  { memberId: 'mbr_ann', userId: 'user_ann', name: 'Ann', email: 'ann@x.test', status: 'ACTIVE' },
  { memberId: 'mbr_bob', userId: 'user_bob', name: 'Bob', email: 'bob@x.test', status: 'ACTIVE' },
];

const team: DeskTeam = {
  id: 'dep_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  name: 'Tier 1',
  description: null,
  managerId: 'user_bob',
  managerName: 'Bob',
  agentIds: ['user_ann'],
  escalationRules: [{ condition: 'no_response', afterMinutes: 30, escalateTo: 'specific_agent', escalateToId: 'user_bob' }],
  isActive: true,
  sortOrder: 2,
};

describe('team form', () => {
  it('reads a team, with the manager as a member id', () => {
    const values = teamToValues(team, members);
    expect(values).toMatchObject({ name: 'Tier 1', managerMemberId: 'mbr_bob', agentIds: ['user_ann'], sortOrder: '2' });
    expect(values.escalationRules[0]).toEqual({
      condition: 'no_response',
      afterMinutes: '30',
      escalateTo: 'specific_agent',
      escalateToId: 'user_bob',
      notifyCustomer: false,
    });
  });

  it('writes the payload the route takes', () => {
    const values = {
      ...emptyTeamValues(3),
      name: ' Tier 2 ',
      agentIds: ['user_ann', 'user_ann', 'user_bob'],
      managerMemberId: 'mbr_ann',
      escalationRules: [
        { ...newEscalationRule(), escalateToId: 'user_bob' },
        { condition: 'sla_breach' as const, afterMinutes: '0', escalateTo: 'next_tier' as const, escalateToId: null, notifyCustomer: true },
      ],
    };
    expect(valuesToTeamInput(values, members)).toEqual({
      name: 'Tier 2',
      description: '',
      agentIds: ['user_ann', 'user_bob'],
      managerId: 'mbr_ann',
      managerName: 'Ann',
      isActive: true,
      sortOrder: 3,
      escalationRules: [
        { condition: 'unassigned', afterMinutes: 15, escalateTo: 'manager' },
        { condition: 'sla_breach', afterMinutes: 0, escalateTo: 'next_tier', notifyCustomer: true },
      ],
    });
  });

  it('checks the name, the order and each rule', () => {
    expect(validateTeamValues(emptyTeamValues(1))).toEqual({ field: 'name' });
    expect(validateTeamValues({ ...emptyTeamValues(1), name: 'x', sortOrder: '1.5' })).toEqual({ field: 'sortOrder' });
    const rule = newEscalationRule();
    expect(
      validateTeamValues({ ...emptyTeamValues(1), name: 'x', escalationRules: [{ ...rule, afterMinutes: '-3' }] }),
    ).toEqual({ field: 'afterMinutes', index: 0 });
    expect(
      validateTeamValues({ ...emptyTeamValues(1), name: 'x', escalationRules: [rule, { ...rule, escalateTo: 'specific_agent' }] }),
    ).toEqual({ field: 'escalateToId', index: 1 });
    expect(validateTeamValues({ ...emptyTeamValues(1), name: 'x', escalationRules: [rule] })).toBeNull();
  });
});
