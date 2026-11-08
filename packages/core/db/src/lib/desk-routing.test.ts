import { describe, expect, it } from 'vitest';
import {
  deskChangeReroutes,
  deskRoutingRuleMatches,
  normalizeDeskRouting,
  selectDeskRoutingRule,
  type DeskRoutingFields,
} from './desk-routing';

const conversation = (values: Partial<DeskRoutingFields> = {}): DeskRoutingFields => ({
  channel: 'email',
  ticketTypeId: null,
  tags: [],
  priority: null,
  departmentId: null,
  ...values,
});

describe('normalizeDeskRouting', () => {
  it('drops rules without an id, repeated ids, empty lists and unknown actions', () => {
    const { rules } = normalizeDeskRouting({
      rules: [
        {
          id: 'r1',
          name: 'VIP',
          enabled: true,
          conditions: { tags: ['vip', '', 'vip'], channels: [] },
          actions: { departmentId: 'dep_1', priority: 'loud', addTags: ['x'], assigneeId: null },
        },
        { name: 'no id' },
        { id: 'r1', name: 'repeat' },
        { id: 'r2', conditions: null, actions: { assigneeId: 'user_a' } },
        'nonsense',
      ],
    });
    expect(rules).toEqual([
      {
        id: 'r1',
        name: 'VIP',
        enabled: true,
        conditions: { tags: ['vip'] },
        actions: { departmentId: 'dep_1', addTags: ['x'] },
      },
      { id: 'r2', name: '', enabled: true, conditions: {}, actions: { assigneeId: 'user_a' } },
    ]);
    expect(normalizeDeskRouting(undefined)).toEqual({ rules: [] });
  });
});

describe('deskRoutingRuleMatches', () => {
  const rule = normalizeDeskRouting({
    rules: [{ id: 'r', conditions: { channels: ['email'], tags: ['VIP', 'refund'] }, actions: {} }],
  }).rules[0]!;

  it('needs every list it sets, and any one of its tags (ignoring case)', () => {
    expect(deskRoutingRuleMatches(rule, conversation({ tags: ['vip'] }))).toBe(true);
    expect(deskRoutingRuleMatches(rule, conversation({ channel: 'messenger', tags: ['vip'] }))).toBe(false);
    expect(deskRoutingRuleMatches(rule, conversation({ tags: [] }))).toBe(false);
  });

  it('never matches an unset value against a list', () => {
    const byPriority = normalizeDeskRouting({ rules: [{ id: 'p', conditions: { priorities: ['high'] } }] }).rules[0]!;
    expect(deskRoutingRuleMatches(byPriority, conversation())).toBe(false);
    expect(deskRoutingRuleMatches(byPriority, conversation({ priority: 'high' }))).toBe(true);
  });

  it('matches every conversation without conditions', () => {
    const any = normalizeDeskRouting({ rules: [{ id: 'a' }] }).rules[0]!;
    expect(deskRoutingRuleMatches(any, conversation({ channel: 'phone' }))).toBe(true);
  });
});

describe('selectDeskRoutingRule', () => {
  it('takes the first enabled rule that matches', () => {
    const { rules } = normalizeDeskRouting({
      rules: [
        { id: 'off', enabled: false, conditions: { channels: ['email'] } },
        { id: 'phone', conditions: { channels: ['phone'] } },
        { id: 'email', conditions: { channels: ['email'] } },
        { id: 'all' },
      ],
    });
    expect(selectDeskRoutingRule(rules, conversation())?.id).toBe('email');
    expect(selectDeskRoutingRule(rules, conversation({ channel: 'api' }))?.id).toBe('all');
    expect(selectDeskRoutingRule([], conversation())).toBeNull();
  });
});

describe('deskChangeReroutes', () => {
  it('re-routes on a new type or tags, and keeps a team the change set', () => {
    const none = { removedTags: [] };
    expect(deskChangeReroutes([{ field: 'tags' }])).toEqual({ reroute: true, keepTeam: false, change: none });
    expect(deskChangeReroutes([{ field: 'ticketType' }, { field: 'team' }])).toEqual({ reroute: true, keepTeam: true, change: none });
    expect(deskChangeReroutes([{ field: 'priority' }])).toEqual({ reroute: false, keepTeam: false, change: none });
    expect(deskChangeReroutes(undefined)).toEqual({ reroute: false, keepTeam: false, change: none });
  });

  it('lists the tags the change removed, in any case', () => {
    const { change } = deskChangeReroutes([{ field: 'tags', from: ['Email', 'vip', 'billing'], to: ['VIP'] }]);
    expect(change.removedTags).toEqual(['Email', 'billing']);
  });
});
