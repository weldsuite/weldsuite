import { describe, expect, it } from 'vitest';
import {
  deskEscalationEpisode,
  deskEscalationsDue,
  runnableDeskEscalationRules,
  type DeskEscalationEpisode,
  type DeskEscalationTimelineEntry,
} from './desk-escalation-check';

const t = (ms: number) => new Date(ms);

function entry(
  ms: number,
  kind: string,
  authorType: string,
  eventType: string | null = null,
  extra: Partial<DeskEscalationTimelineEntry> = {},
): DeskEscalationTimelineEntry {
  return { at: t(ms), kind, authorType, eventType, teamChanged: false, teamId: null, ruleIndex: null, ...extra };
}

const rules = runnableDeskEscalationRules([
  { condition: 'unassigned', afterMinutes: 10, escalateTo: 'manager' },
  { condition: 'no_response', afterMinutes: 30, escalateTo: 'next_tier', notifyCustomer: true },
  { condition: 'custom', afterMinutes: 1, escalateTo: 'manager' },
  { condition: 'sla_breach', afterMinutes: 0, escalateTo: 'specific_agent', escalateToId: 'user_x' },
  { condition: 'unassigned', afterMinutes: -1, escalateTo: 'manager' },
]);

describe('runnableDeskEscalationRules', () => {
  it('keeps each rule with its stored index and skips custom and malformed ones', () => {
    expect(rules.map((r) => r.index)).toEqual([0, 1, 3]);
    expect(runnableDeskEscalationRules(null)).toEqual([]);
  });
});

describe('deskEscalationEpisode', () => {
  it('follows the owner, the waiting customer and the team', () => {
    const episode = deskEscalationEpisode(t(0), [
      entry(0, 'message', 'visitor'),
      entry(10, 'message', 'visitor'),
      entry(20, 'event', 'system', 'assigned'),
      entry(30, 'message', 'agent'),
      entry(40, 'event', 'agent', 'unassigned'),
      entry(50, 'event', 'agent', 'attributes_changed', { teamChanged: true }),
      entry(60, 'message', 'visitor'),
      entry(70, 'event', 'system', 'escalated', { teamId: 'dep_1', ruleIndex: 0 }),
    ]);
    expect(episode.teamEnteredAt).toEqual(t(50));
    expect(episode.unassignedSince).toEqual(t(40));
    expect(episode.waitingSince).toEqual(t(60));
    expect(episode.fired).toEqual([{ teamId: 'dep_1', ruleIndex: 0, at: t(70) }]);
  });

  it('starts a new episode when the customer reopens a closed conversation', () => {
    const episode = deskEscalationEpisode(t(0), [
      entry(0, 'message', 'visitor'),
      entry(10, 'event', 'agent', 'closed'),
      entry(20, 'message', 'visitor'),
    ]);
    expect(episode.unassignedSince).toEqual(t(20));
    expect(episode.waitingSince).toEqual(t(20));
  });
});

describe('deskEscalationsDue', () => {
  const open = { state: 'open' as const, assigneeId: null, departmentId: 'dep_1' };

  it('anchors each rule on the later of its condition and the move into the team', () => {
    const episode: DeskEscalationEpisode = { teamEnteredAt: t(100), unassignedSince: t(0), waitingSince: t(200), fired: [] };
    const due = deskEscalationsDue({ conversation: open, rules, episode, breachedAt: t(1_000) });
    expect(due.map((d) => [d.index, d.dueAt.getTime()])).toEqual([
      [3, 1_000],
      [0, 600_100],
      [1, 1_800_200],
    ]);
  });

  it('fires a rule once per episode, per team', () => {
    const episode: DeskEscalationEpisode = {
      teamEnteredAt: t(0),
      unassignedSince: t(0),
      waitingSince: null,
      fired: [{ teamId: 'dep_1', ruleIndex: 0, at: t(700_000) }],
    };
    expect(deskEscalationsDue({ conversation: open, rules, episode, breachedAt: null })).toEqual([]);
    // Unassigned again later: a new episode.
    const again = deskEscalationsDue({ conversation: open, rules, episode: { ...episode, unassignedSince: t(800_000) }, breachedAt: null });
    expect(again.map((d) => d.dueAt.getTime())).toEqual([1_400_000]);
    // Another team's escalation does not count.
    const other = { ...episode, fired: [{ teamId: 'dep_2', ruleIndex: 0, at: t(700_000) }] };
    expect(deskEscalationsDue({ conversation: open, rules, episode: other, breachedAt: null })).toHaveLength(1);
  });

  it('has nothing for an owned, closed or teamless conversation', () => {
    const episode: DeskEscalationEpisode = { teamEnteredAt: t(0), unassignedSince: t(0), waitingSince: null, fired: [] };
    expect(deskEscalationsDue({ conversation: { ...open, assigneeId: 'user_a' }, rules, episode, breachedAt: null })).toEqual([]);
    expect(deskEscalationsDue({ conversation: { ...open, state: 'closed' }, rules, episode, breachedAt: null })).toEqual([]);
    expect(deskEscalationsDue({ conversation: { ...open, departmentId: null }, rules, episode, breachedAt: null })).toEqual([]);
  });
});
