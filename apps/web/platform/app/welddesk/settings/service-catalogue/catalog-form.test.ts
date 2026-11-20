import { describe, expect, it } from 'vitest';
import type { DeskCatalogItem } from '@weldsuite/core-api-client/schemas/desk-catalog';
import {
  approverSummary,
  categoriesOf,
  emptyCatalogValues,
  emptyStep,
  emptyTask,
  itemToValues,
  moveEntry,
  reorderPatches,
  validateCatalogValues,
  valuesToInput,
  type CatalogFormValues,
} from './catalog-form';

const item: DeskCatalogItem = {
  id: 'dcat_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Laptop',
  summary: 'A work laptop',
  description: null,
  category: 'Hardware',
  icon: 'laptop',
  ticketTypeId: 'ttyp_hw',
  departmentId: 'dept_it',
  priority: 'high',
  deliveryEstimate: '3 days',
  approvalSteps: [
    { id: 's1', name: 'Budget', approverType: 'member', approverId: 'user_a' },
    { id: 's2', approverType: 'team_manager', departmentId: null },
  ],
  fulfilmentTasks: [{ id: 't1', title: 'Order it', description: 'From the shop', assigneeId: null, dueInDays: 5 }],
  audienceCompanyIds: ['co_1'],
  isActive: true,
  sortOrder: 2,
  createdById: 'user_a',
};

const valid = (extra: Partial<CatalogFormValues> = {}): CatalogFormValues => ({
  ...emptyCatalogValues(),
  name: 'Headset',
  ticketTypeId: 'ttyp_hw',
  ...extra,
});

describe('validateCatalogValues', () => {
  it('wants a name and a form first', () => {
    expect(validateCatalogValues(emptyCatalogValues())).toBe('nameRequired');
    expect(validateCatalogValues({ ...emptyCatalogValues(), name: ' x ' })).toBe('typeRequired');
    expect(validateCatalogValues(valid())).toBeNull();
  });

  it('wants an approver on every member step and a title on every task', () => {
    expect(validateCatalogValues(valid({ approvalSteps: [emptyStep()] }))).toBe('stepApprover');
    expect(validateCatalogValues(valid({ approvalSteps: [{ ...emptyStep(), approverType: 'team_manager' }] }))).toBeNull();
    expect(validateCatalogValues(valid({ fulfilmentTasks: [emptyTask()] }))).toBe('taskTitle');
    expect(validateCatalogValues(valid({ fulfilmentTasks: [{ ...emptyTask(), title: 'Do it' }] }))).toBeNull();
  });

  it('caps the steps and the tasks', () => {
    const steps = Array.from({ length: 6 }, () => ({ ...emptyStep(), approverType: 'team_manager' as const }));
    expect(validateCatalogValues(valid({ approvalSteps: steps }))).toBe('tooManySteps');
    const tasks = Array.from({ length: 21 }, () => ({ ...emptyTask(), title: 'T' }));
    expect(validateCatalogValues(valid({ fulfilmentTasks: tasks }))).toBe('tooManyTasks');
  });
});

describe('values and input', () => {
  it('round-trips an item through the form', () => {
    const input = valuesToInput(itemToValues(item));
    expect(input).toMatchObject({
      name: 'Laptop',
      summary: 'A work laptop',
      description: null,
      category: 'Hardware',
      icon: 'laptop',
      ticketTypeId: 'ttyp_hw',
      departmentId: 'dept_it',
      priority: 'high',
      deliveryEstimate: '3 days',
      audienceCompanyIds: ['co_1'],
      isActive: true,
    });
    expect(input.approvalSteps).toEqual([
      { id: 's1', name: 'Budget', approverType: 'member', approverId: 'user_a' },
      { id: 's2', name: null, approverType: 'team_manager', departmentId: null },
    ]);
    expect(input.fulfilmentTasks).toEqual([
      { id: 't1', title: 'Order it', description: 'From the shop', assigneeId: null, dueInDays: 5 },
    ]);
  });

  it('clears empty text, keeps defaults as null and bounds the due days', () => {
    const input = valuesToInput(
      valid({
        summary: '   ',
        priority: '',
        departmentId: '',
        fulfilmentTasks: [
          { ...emptyTask(), title: ' Do it ', dueInDays: '400' },
          { ...emptyTask(), title: 'Soon', dueInDays: '' },
          { ...emptyTask(), title: 'Now', dueInDays: '0' },
        ],
      }),
    );
    expect(input).toMatchObject({ summary: null, priority: null, departmentId: null });
    expect(input.fulfilmentTasks?.map((t) => [t.title, t.dueInDays])).toEqual([
      ['Do it', 365],
      ['Soon', null],
      ['Now', 0],
    ]);
  });
});

describe('ordering', () => {
  it('moves an entry one place and leaves the ends alone', () => {
    expect(moveEntry(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveEntry(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });

  it('renumbers the items and returns only the ones whose number changes', () => {
    const items = [
      { id: 'a', sortOrder: 0 },
      { id: 'b', sortOrder: 0 },
      { id: 'c', sortOrder: 7 },
    ];
    expect(reorderPatches(items, 2, -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
    expect(reorderPatches(items, 0, -1)).toEqual([{ id: 'b', sortOrder: 1 }, { id: 'c', sortOrder: 2 }]);
  });
});

describe('summaries', () => {
  it('lists the categories in use once, sorted', () => {
    expect(categoriesOf([{ category: 'Hardware' }, { category: null }, { category: 'Access' }, { category: ' Hardware ' }])).toEqual(['Access', 'Hardware']);
  });

  it('names who approves each step', () => {
    const labels = { managerOf: 'manager of {team}', requestTeamManager: 'manager of the request team', unknownMember: 'a former member' };
    const names = { member: (id: string) => (id === 'user_a' ? 'Alice' : undefined), team: (id: string) => (id === 'dept_it' ? 'IT' : undefined) };
    expect(
      approverSummary(
        [
          { id: '1', approverType: 'member', approverId: 'user_a' },
          { id: '2', approverType: 'member', approverId: 'user_gone' },
          { id: '3', approverType: 'team_manager', departmentId: 'dept_it' },
          { id: '4', approverType: 'team_manager' },
        ],
        names,
        labels,
      ),
    ).toBe('Alice, a former member, manager of IT, manager of the request team');
  });
});
