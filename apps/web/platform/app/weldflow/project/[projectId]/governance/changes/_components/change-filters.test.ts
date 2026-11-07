import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '@weldsuite/app-api-client/domains/flow-approvals';
import { applyChangeFilters, EMPTY_CHANGE_FILTERS } from './change-filters';

const change = (overrides: Partial<ChangeRequest>): ChangeRequest =>
  ({
    id: 'c1',
    projectId: 'p1',
    number: 1,
    code: 'CR-1',
    title: 'Move go-live',
    description: null,
    requestedBy: 'u1',
    requestedByName: 'Ann',
    status: 'draft',
    costDelta: null,
    scheduleDeltaDays: null,
    planChanges: null,
    scopeChanges: null,
    route: null,
    submittedAt: null,
    decidedAt: null,
    baselineId: null,
    clientVisible: false,
    createdBy: 'u1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  }) as ChangeRequest;

const changes = [
  change({ id: 'c1', code: 'CR-1', title: 'Move go-live', status: 'draft' }),
  change({ id: 'c2', code: 'CR-2', title: 'Extra training', description: 'Two more sessions', status: 'awaiting_approval', route: 'board' }),
  change({ id: 'c3', code: 'CR-3', title: 'Cut the pilot', status: 'approved', route: 'manager' }),
];

const filter = (field: string, operator: string, value: string) => ({ id: `${field}-${value}`, field, operator, value });
const ids = (list: ChangeRequest[]) => list.map((c) => c.id);

describe('applyChangeFilters', () => {
  it('keeps everything without a search or filter', () => {
    expect(ids(applyChangeFilters(changes, EMPTY_CHANGE_FILTERS))).toEqual(['c1', 'c2', 'c3']);
  });

  it('searches the code, the title and the description', () => {
    expect(ids(applyChangeFilters(changes, { search: 'cr-3', filters: [] }))).toEqual(['c3']);
    expect(ids(applyChangeFilters(changes, { search: ' GO-LIVE ', filters: [] }))).toEqual(['c1']);
    expect(ids(applyChangeFilters(changes, { search: 'sessions', filters: [] }))).toEqual(['c2']);
    expect(applyChangeFilters(changes, { search: 'nothing like this', filters: [] })).toEqual([]);
  });

  it('keeps the matches of an `is` filter and drops them for `is not`', () => {
    expect(ids(applyChangeFilters(changes, { search: '', filters: [filter('status', 'is', 'approved')] }))).toEqual(['c3']);
    expect(ids(applyChangeFilters(changes, { search: '', filters: [filter('status', 'is not', 'approved')] }))).toEqual(['c1', 'c2']);
  });

  it('filters by route, a draft having none', () => {
    expect(ids(applyChangeFilters(changes, { search: '', filters: [filter('route', 'is', 'board')] }))).toEqual(['c2']);
    expect(ids(applyChangeFilters(changes, { search: '', filters: [filter('route', 'is not', 'board')] }))).toEqual(['c1', 'c3']);
  });

  it('narrows by every filter in turn and by the search together with them', () => {
    const both = { search: 'cr', filters: [filter('status', 'is not', 'draft'), filter('route', 'is', 'manager')] };
    expect(ids(applyChangeFilters(changes, both))).toEqual(['c3']);
  });

  it('ignores a filter that is still being built', () => {
    expect(ids(applyChangeFilters(changes, { search: '', filters: [filter('status', '', ''), filter('route', 'is', '')] }))).toEqual(['c1', 'c2', 'c3']);
  });
});
