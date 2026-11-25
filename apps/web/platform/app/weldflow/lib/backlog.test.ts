import { describe, expect, it } from 'vitest';
import {
  BACKLOG_SECTION,
  buildSections,
  burnupSeries,
  countUnestimated,
  daysLeft,
  dropItem,
  groupEpicItems,
  nextSprintDraft,
  pickableTypes,
  NO_EPIC,
  sectionSprintId,
  sprintPlan,
  quickCreateInput,
  typeChangeInput,
  type BacklogItem,
} from './backlog';

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || null,
    title: `Item ${id}`,
    type: 'story',
    status: 'todo',
    priority: 'medium',
    sprintId: null,
    epicId: null,
    storyPoints: null,
    assigneeId: null,
    assigneeName: null,
    assigneeAvatar: null,
    position: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    completedDate: null,
    ...over,
  };
}

describe('buildSections', () => {
  const items = [
    item('a1', { position: 3 }),
    item('a2', { position: 1 }),
    item('a3', { sprintId: 's1', position: 1 }),
    item('a4', { sprintId: 's2', position: 1 }),
    item('a5', { status: 'done' }),
    item('a6', { type: 'epic' }),
    item('a7', { sprintId: 'old', position: 1 }),
    item('a8', { sprintId: 's1', status: 'done', position: 2 }),
  ];

  it('puts items in their sprint or the backlog, ordered by position', () => {
    const sections = buildSections(items, ['s1', 's2']);
    expect(sections[BACKLOG_SECTION]?.map((i) => i.id)).toEqual(['a2', 'a1']);
    expect(sections.s1?.map((i) => i.id)).toEqual(['a3', 'a8']);
    expect(sections.s2?.map((i) => i.id)).toEqual(['a4']);
  });

  it('leaves out done backlog items, epics and items of sprints not shown', () => {
    const all = Object.values(buildSections(items, ['s1', 's2'])).flat().map((i) => i.id);
    expect(all).not.toContain('a5');
    expect(all).not.toContain('a6');
    expect(all).not.toContain('a7');
  });

  it('filters by epic, by no epic and by search', () => {
    const list = [item('b1', { epicId: 'e1' }), item('b2'), item('b3', { epicId: 'e2', title: 'Refund flow' })];
    expect(buildSections(list, [], { epicId: 'e1', search: '' })[BACKLOG_SECTION]?.map((i) => i.id)).toEqual(['b1']);
    expect(buildSections(list, [], { epicId: NO_EPIC, search: '' })[BACKLOG_SECTION]?.map((i) => i.id)).toEqual(['b2']);
    expect(buildSections(list, [], { epicId: null, search: 'refund' })[BACKLOG_SECTION]?.map((i) => i.id)).toEqual(['b3']);
    expect(buildSections(list, [], { epicId: null, search: '', type: 'bug' })[BACKLOG_SECTION]).toEqual([]);
  });
});

describe('sprintPlan', () => {
  it('compares the planned points with the forecast', () => {
    const items = [item('c1', { storyPoints: 8 }), item('c2', { storyPoints: 5 }), item('c3')];
    expect(sprintPlan(items, 10)).toMatchObject({ points: 13, forecast: 10, over: true });
    expect(sprintPlan(items, 20)).toMatchObject({ points: 13, over: false });
    expect(sprintPlan(items, null)).toMatchObject({ points: 13, over: null });
  });

  it('counts items without an estimate, spikes aside', () => {
    expect(countUnestimated([item('d1'), item('d2', { type: 'spike' }), item('d3', { storyPoints: 0 })])).toBe(1);
  });
});

describe('nextSprintDraft', () => {
  const today = new Date('2026-11-25T10:00:00.000Z');

  it('starts today with no sprints', () => {
    expect(nextSprintDraft([], 14, today, 'Sprint')).toEqual({
      name: 'Sprint 1',
      startDate: '2026-11-25T00:00:00.000Z',
      endDate: '2026-12-08T00:00:00.000Z',
    });
  });

  it('follows the last open sprint and takes the next number', () => {
    const draft = nextSprintDraft(
      [
        { name: 'Sprint 14', status: 'active', endDate: '2026-12-01T00:00:00.000Z' },
        { name: 'Sprint 9', status: 'completed', endDate: '2026-09-01T00:00:00.000Z' },
      ],
      7,
      today,
      'Sprint',
    );
    expect(draft).toEqual({ name: 'Sprint 15', startDate: '2026-12-02T00:00:00.000Z', endDate: '2026-12-08T00:00:00.000Z' });
  });

  it('does not start in the past', () => {
    const draft = nextSprintDraft([{ name: 'Sprint 2', status: 'planned', endDate: '2026-10-01T00:00:00.000Z' }], 14, today, 'Sprint');
    expect(draft.startDate).toBe('2026-11-25T00:00:00.000Z');
  });
});

describe('daysLeft', () => {
  it('counts the end day and stops at zero', () => {
    const today = new Date('2026-11-25T10:00:00.000Z');
    expect(daysLeft('2026-11-25T00:00:00.000Z', today)).toBe(1);
    expect(daysLeft('2026-11-29T00:00:00.000Z', today)).toBe(5);
    expect(daysLeft('2026-11-01T00:00:00.000Z', today)).toBe(0);
    expect(daysLeft(null, today)).toBeNull();
  });
});

describe('dropItem', () => {
  const sections = {
    [BACKLOG_SECTION]: [item('x1'), item('x2'), item('x3')],
    s1: [item('y1', { sprintId: 's1' }), item('y2', { sprintId: 's1' })],
    s2: [],
  };

  it('reorders within a section like a sortable list', () => {
    expect(dropItem(sections, 'x1', 'x3')).toEqual({ targetId: BACKLOG_SECTION, targetOrder: ['x2', 'x3', 'x1'] });
    expect(dropItem(sections, 'x3', 'x1')).toEqual({ targetId: BACKLOG_SECTION, targetOrder: ['x3', 'x1', 'x2'] });
  });

  it('does nothing when the order is the same', () => {
    expect(dropItem(sections, 'x1', 'x1')).toBeNull();
    expect(dropItem(sections, 'x1', BACKLOG_SECTION)).toEqual({ targetId: BACKLOG_SECTION, targetOrder: ['x2', 'x3', 'x1'] });
    expect(dropItem(sections, 'x3', BACKLOG_SECTION)).toBeNull();
  });

  it('moves an item before the one it lands on in another section', () => {
    expect(dropItem(sections, 'x2', 'y2')).toEqual({
      targetId: 's1',
      targetOrder: ['y1', 'x2', 'y2'],
      sourceId: BACKLOG_SECTION,
      sourceOrder: ['x1', 'x3'],
    });
  });

  it('drops on an empty section or on the end of one', () => {
    expect(dropItem(sections, 'x1', 's2')).toMatchObject({ targetId: 's2', targetOrder: ['x1'] });
    expect(dropItem(sections, 'y1', BACKLOG_SECTION)).toMatchObject({ targetId: BACKLOG_SECTION, targetOrder: ['x1', 'x2', 'x3', 'y1'] });
  });

  it('maps a section to its sprint', () => {
    expect(sectionSprintId(BACKLOG_SECTION)).toBeNull();
    expect(sectionSprintId('s1')).toBe('s1');
  });
});

describe('burnupSeries', () => {
  const now = Date.parse('2026-11-11T00:00:00.000Z');

  it('is empty without items', () => {
    expect(burnupSeries([], now)).toEqual([]);
  });

  it('grows the scope with created items and the done line with completed ones', () => {
    const series = burnupSeries(
      [
        { storyPoints: 5, createdAt: '2026-11-01T00:00:00.000Z', completedDate: '2026-11-05T00:00:00.000Z', status: 'done' },
        { storyPoints: 3, createdAt: '2026-11-07T00:00:00.000Z', completedDate: null, status: 'todo' },
        { storyPoints: null, createdAt: '2026-11-02T00:00:00.000Z', completedDate: null, status: 'todo' },
      ],
      now,
    );
    expect(series[0]).toMatchObject({ scope: 5, done: 0 });
    expect(series.at(-1)).toEqual({ t: now, scope: 8, done: 5 });
    const scopes = series.map((p) => p.scope);
    expect([...scopes].sort((a, b) => a - b)).toEqual(scopes);
  });

  it('never makes more than the requested number of points', () => {
    const series = burnupSeries(
      [{ storyPoints: 1, createdAt: '2025-01-01T00:00:00.000Z', completedDate: null, status: 'todo' }],
      now,
      12,
    );
    expect(series.length).toBeLessThanOrEqual(13);
  });
});

describe('groupEpicItems', () => {
  const sprints = [
    { id: 's2', name: 'Sprint 2', status: 'planned', startDate: '2026-12-01T00:00:00.000Z' },
    { id: 's1', name: 'Sprint 1', status: 'completed', startDate: '2026-11-01T00:00:00.000Z' },
  ];

  it('groups by sprint, oldest first, with the backlog last and empty groups left out', () => {
    const groups = groupEpicItems(
      [item('g1'), item('g2', { sprintId: 's2' }), item('g3', { sprintId: 's1', position: 2 }), item('g4', { sprintId: 's1', position: 1 })],
      sprints,
    );
    expect(groups.map((group) => group.id)).toEqual(['s1', 's2', BACKLOG_SECTION]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['g4', 'g3']);
  });

  it('puts items of an unlisted sprint under earlier sprints, first', () => {
    const groups = groupEpicItems([item('h1', { sprintId: 'gone' }), item('h2', { sprintId: 's1' })], sprints);
    expect(groups.map((group) => group.kind)).toEqual(['earlier', 'sprint']);
  });
});

describe('type changes', () => {
  it('offers every enabled type but the subtask', () => {
    expect(pickableTypes(['epic', 'story', 'subtask', 'bug'])).toEqual(['epic', 'story', 'bug']);
  });

  it('takes an epic out of its sprint and epic', () => {
    expect(typeChangeInput('epic')).toEqual({ type: 'epic', sprintId: null, epicId: null });
    expect(typeChangeInput('bug')).toEqual({ type: 'bug' });
  });

  it('quick-creates items in the section and the filtered epic, containers outside both', () => {
    const epic = { id: 'e1', type: 'epic' };
    const feature = { id: 'f1', type: 'feature' };
    expect(quickCreateInput('bug', 's1', epic)).toEqual({ type: 'bug', sprintId: 's1', epicId: 'e1' });
    expect(quickCreateInput('story', 's1', feature)).toEqual({ type: 'story', sprintId: 's1', epicId: 'f1' });
    expect(quickCreateInput('task', null, undefined)).toEqual({ type: 'task', sprintId: null, epicId: null });
    // An epic is never planned in a sprint and belongs to no epic.
    expect(quickCreateInput('epic', 's1', epic)).toEqual({ type: 'epic', sprintId: null, epicId: null });
    // A feature belongs to an epic only, never to a feature, and not to a sprint.
    expect(quickCreateInput('feature', 's1', epic)).toEqual({ type: 'feature', sprintId: null, epicId: 'e1' });
    expect(quickCreateInput('feature', 's1', feature)).toEqual({ type: 'feature', sprintId: null, epicId: null });
  });
});
