import { describe, expect, it } from 'vitest';
import {
  cleanTags,
  emptyRoutingValues,
  moveRule,
  ruleSummary,
  ruleToValues,
  validateRoutingValues,
  valuesToRule,
  type RoutingSummaryStrings,
} from './routing-form';

const strings: RoutingSummaryStrings = {
  summary: {
    channels: 'channel {values}',
    types: 'type {values}',
    tags: 'tagged {values}',
    priorities: 'priority {values}',
    teams: 'team {values}',
    toTeam: 'move to {value}',
    toAssignee: 'assign to {value}',
    setPriority: 'set priority to {value}',
    addTags: 'add {values}',
    or: ' or ',
  },
  list: { matchesAll: 'Every conversation', noActions: 'Does nothing yet' },
};

const names = {
  channel: (id: string) => id.toUpperCase(),
  priority: (id: string) => `P:${id}`,
  type: (id: string) => `T:${id}`,
  team: (id: string) => `Team ${id}`,
  member: (id: string) => `M:${id}`,
};

describe('routing form', () => {
  it('sends only the lists and actions that are set', () => {
    const rule = valuesToRule('rule_1', {
      ...emptyRoutingValues(),
      name: '  VIP ',
      channels: ['email'],
      tags: [' vip ', 'VIP', ''],
      departmentId: 'dep_1',
      addTags: [],
    });
    expect(rule).toEqual({
      id: 'rule_1',
      name: 'VIP',
      enabled: true,
      conditions: { channels: ['email'], tags: ['vip'] },
      actions: { departmentId: 'dep_1' },
    });
    expect(ruleToValues(rule)).toMatchObject({ name: 'VIP', channels: ['email'], tags: ['vip'], departmentId: 'dep_1', priority: null });
  });

  it('needs a name and at least one action', () => {
    expect(validateRoutingValues(emptyRoutingValues())).toBe('nameRequired');
    expect(validateRoutingValues({ ...emptyRoutingValues(), name: 'x' })).toBe('noAction');
    expect(validateRoutingValues({ ...emptyRoutingValues(), name: 'x', priority: 'high' })).toBeNull();
  });

  it('moves rules within the list only', () => {
    expect(moveRule(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRule(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveRule(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('cleans tags', () => {
    expect(cleanTags(['  two   words ', 'Two words', 'x'.repeat(60)])).toEqual(['two words', 'x'.repeat(50)]);
  });

  it('summarises a rule', () => {
    const summary = ruleSummary(
      {
        id: 'r',
        name: 'r',
        enabled: true,
        conditions: { channels: ['email', 'phone'], tags: ['vip'] },
        actions: { departmentId: 'dep_1', priority: 'high' },
      },
      strings,
      names,
    );
    expect(summary).toEqual({ when: 'channel EMAIL or PHONE · tagged vip', then: 'move to Team dep_1 · set priority to P:high' });
    expect(ruleSummary({ id: 'r', name: 'r', enabled: true, conditions: {}, actions: {} }, strings, names)).toEqual({
      when: 'Every conversation',
      then: 'Does nothing yet',
    });
  });
});
