import { describe, expect, it } from 'vitest';
import type { LinkedObject, RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import {
  EMPTY_FILTERS,
  NO_OWNER,
  ageInDays,
  applyRegisterFilters,
  categoriesIn,
  formatShortDate,
  fromDateInput,
  hasActiveFilters,
  initialsOf,
  itemsOfKind,
  linkedMilestones,
  linkedRaidItems,
  linkedTasks,
  ownerIdsOf,
  progressPercent,
  sortRegister,
  statusTone,
  toDateInput,
} from './raid';

const NOW = new Date(2026, 9, 29, 10, 0, 0);

function item(kind: RaidKind, overrides: Partial<RaidItem> = {}): RaidItem {
  return {
    id: `raid_${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'proj_1',
    kind,
    number: 1,
    code: 'X-1',
    title: 'An item',
    description: null,
    status: 'open',
    category: null,
    ownerId: null,
    dueAt: null,
    closedAt: null,
    customFields: null,
    probability: null,
    impact: null,
    score: null,
    band: null,
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    strategy: null,
    trigger: null,
    costImpact: null,
    scheduleImpactDays: null,
    reviewIntervalDays: null,
    confidence: null,
    ifWrong: null,
    severity: null,
    escalatedAt: null,
    direction: null,
    partyType: null,
    partyProjectId: null,
    partyName: null,
    createdBy: 'user_1',
    createdAt: new Date(2026, 9, 23, 12).toISOString(),
    updatedAt: new Date(2026, 9, 23, 12).toISOString(),
    deletedAt: null,
    taskProgress: { done: 0, total: 0 },
    ...overrides,
  };
}

const daysFromNow = (days: number) => new Date(2026, 9, 29 + days, 12).toISOString();

describe('filters', () => {
  const a = item('risk', { id: 'a', code: 'RSK-1', title: 'Payment API changes', category: 'Technical', status: 'mitigating', ownerId: 'u1' });
  const b = item('risk', { id: 'b', code: 'RSK-2', title: 'Hosting costs', category: 'budget', status: 'monitoring', ownerId: null, description: 'Above the approved budget' });
  const c = item('risk', { id: 'c', code: 'RSK-3', title: 'Translations late', category: null, status: 'mitigating', ownerId: 'u2' });
  const all = [a, b, c];

  it('passes everything with no filter', () => {
    expect(applyRegisterFilters(all, EMPTY_FILTERS)).toHaveLength(3);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('searches code, title and description without regard to case', () => {
    expect(applyRegisterFilters(all, { ...EMPTY_FILTERS, search: 'payment' })).toEqual([a]);
    expect(applyRegisterFilters(all, { ...EMPTY_FILTERS, search: 'rsk-3' })).toEqual([c]);
    expect(applyRegisterFilters(all, { ...EMPTY_FILTERS, search: ' APPROVED ' })).toEqual([b]);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: 'x' })).toBe(true);
  });

  const where = (...filters: Array<[string, string, string]>) => ({
    ...EMPTY_FILTERS,
    filters: filters.map(([field, operator, value], index) => ({ id: String(index), field, operator, value })),
  });

  it('filters by status, owner and category', () => {
    expect(applyRegisterFilters(all, where(['status', 'is', 'mitigating']))).toEqual([a, c]);
    expect(applyRegisterFilters(all, where(['owner', 'is', 'u2']))).toEqual([c]);
    expect(applyRegisterFilters(all, where(['owner', 'is', NO_OWNER]))).toEqual([b]);
    expect(applyRegisterFilters(all, where(['category', 'is', 'TECHNICAL']))).toEqual([a]);
    expect(applyRegisterFilters(all, where(['status', 'is', 'mitigating'], ['owner', 'is', 'u1']))).toEqual([a]);
    expect(hasActiveFilters(where(['status', 'is', 'mitigating']))).toBe(true);
  });

  it('drops the matches of an "is not" filter', () => {
    expect(applyRegisterFilters(all, where(['status', 'is not', 'mitigating']))).toEqual([b]);
    expect(applyRegisterFilters(all, where(['owner', 'is not', NO_OWNER]))).toEqual([a, c]);
  });

  it('ignores a filter that is still being built', () => {
    expect(applyRegisterFilters(all, where(['status', 'is', '']))).toHaveLength(3);
    expect(hasActiveFilters(where(['status', '', '']))).toBe(false);
  });

  it('lists the categories in use once, lower-cased and sorted', () => {
    expect(categoriesIn(all)).toEqual(['budget', 'technical']);
  });

  it('lists the owners in use, and picks the items of one kind', () => {
    expect(ownerIdsOf(all)).toEqual(['u1', 'u2']);
    expect(itemsOfKind([a, item('issue')], 'risk')).toEqual([a]);
    expect(itemsOfKind(undefined, 'risk')).toEqual([]);
  });
});

describe('sortRegister', () => {
  it('puts open items first, then the closed ones, newest number first', () => {
    const open = item('assumption', { id: 'open', number: 3, dueAt: daysFromNow(5) });
    const soon = item('assumption', { id: 'soon', number: 4, dueAt: daysFromNow(1) });
    const undated = item('assumption', { id: 'undated', number: 1 });
    const closedOld = item('assumption', { id: 'closed-old', number: 2, status: 'validated', closedAt: daysFromNow(-3) });
    const closedNew = item('assumption', { id: 'closed-new', number: 5, status: 'invalid', closedAt: daysFromNow(-1) });
    expect(sortRegister('assumption', [closedOld, open, undated, closedNew, soon]).map((i) => i.id)).toEqual([
      'soon',
      'open',
      'undated',
      'closed-new',
      'closed-old',
    ]);
  });

  it('orders open issues by severity before date', () => {
    const medium = item('issue', { id: 'medium', severity: 'medium', dueAt: daysFromNow(1) });
    const critical = item('issue', { id: 'critical', severity: 'critical', dueAt: daysFromNow(9) });
    const high = item('issue', { id: 'high', severity: 'high', dueAt: daysFromNow(2) });
    expect(sortRegister('issue', [medium, critical, high]).map((i) => i.id)).toEqual(['critical', 'high', 'medium']);
  });
});

describe('age and progress', () => {
  it('counts the days an item has been open, never below zero', () => {
    expect(ageInDays(daysFromNow(-6), NOW)).toBe(6);
    expect(ageInDays(daysFromNow(2), NOW)).toBe(0);
  });

  it('turns task progress into a whole percent', () => {
    expect(progressPercent({ done: 1, total: 4 })).toBe(25);
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
  });
});

describe('statuses', () => {
  it('colours the status of each kind', () => {
    expect(statusTone('risk', 'mitigating')).toBe('orange');
    expect(statusTone('risk', 'occurred')).toBe('red');
    expect(statusTone('assumption', 'validated')).toBe('green');
    expect(statusTone('dependency', 'at_risk')).toBe('orange');
    expect(statusTone('issue', 'something-new')).toBe('neutral');
  });
});

describe('links of an item', () => {
  function link(overrides: Omit<Partial<LinkedObject>, 'target'> & { target?: Partial<LinkedObject['target']> }): LinkedObject {
    const { target, ...rest } = overrides;
    return {
      id: 'pcl_1',
      projectId: 'proj_1',
      fromType: 'task',
      fromId: 'task_1',
      toType: 'raid_item',
      toId: 'raid_1',
      relation: 'mitigates',
      createdBy: 'user_1',
      createdAt: '2026-10-01T10:00:00.000Z',
      direction: 'incoming',
      target: { type: 'task', id: 'task_1', projectId: 'proj_1', title: 'Do it', status: 'todo', code: null, ownerId: null, dueDate: null, ...target },
      ...rest,
    };
  }
  const task = link({ id: 'l1' });
  const resolves = link({ id: 'l2', relation: 'resolves' });
  const milestone = link({
    id: 'l3',
    fromType: 'raid_item',
    toType: 'milestone',
    relation: 'threatens',
    direction: 'outgoing',
    target: { type: 'milestone', id: 'ms_1', title: 'Go-live' },
  });
  const raisedFrom = link({
    id: 'l4',
    fromType: 'raid_item',
    toType: 'raid_item',
    relation: 'raised_from',
    direction: 'outgoing',
    target: { type: 'raid_item', id: 'raid_0', code: 'A-1' },
  });
  const detail = { links: [task, resolves, milestone, raisedFrom] };

  it('picks the mitigation and resolution tasks', () => {
    expect(linkedTasks(detail).map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(linkedTasks(undefined)).toEqual([]);
  });

  it('picks the milestones and the other register items', () => {
    expect(linkedMilestones(detail).map((l) => l.id)).toEqual(['l3']);
    expect(linkedRaidItems(detail).map((l) => l.id)).toEqual(['l4']);
  });
});

describe('display helpers', () => {
  it('takes initials', () => {
    expect(initialsOf('Sanne Jansen')).toBe('SJ');
    expect(initialsOf('Milan de Boer')).toBe('MB');
    expect(initialsOf('madonna')).toBe('MA');
    expect(initialsOf('  ')).toBe('?');
  });

  it('drops the year for dates in the current year', () => {
    expect(formatShortDate(new Date(2026, 9, 27, 12).toISOString(), 'en-GB', NOW)).toBe('27 Oct');
    expect(formatShortDate(new Date(2027, 0, 15, 12).toISOString(), 'en-GB', NOW)).toBe('15 Jan 2027');
    expect(formatShortDate(null, 'en-GB', NOW)).toBe('');
  });

  it('converts between a date input and a timestamp without slipping a day', () => {
    expect(toDateInput(fromDateInput('2026-11-16'))).toBe('2026-11-16');
    expect(toDateInput(fromDateInput('2026-12-31'))).toBe('2026-12-31');
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('16-11-2026')).toBeNull();
    expect(toDateInput(null)).toBe('');
    expect(toDateInput('not a date')).toBe('');
  });
});
