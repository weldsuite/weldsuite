import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_SETTINGS,
  completeSprintInputSchema,
  createRetroCardInputSchema,
  createSprintInputSchema,
  deliverySettingsInputSchema,
  readDeliverySettings,
  sprintReportSchema,
  startSprintInputSchema,
  updateRetroCardInputSchema,
  updateSprintInputSchema,
} from './flow-agile';

describe('readDeliverySettings', () => {
  it('reads a project that never chose an approach as a task list', () => {
    expect(readDeliverySettings(undefined)).toBe(DEFAULT_DELIVERY_SETTINGS);
    expect(readDeliverySettings(null)).toBe(DEFAULT_DELIVERY_SETTINGS);
    expect(readDeliverySettings('scrum')).toBe(DEFAULT_DELIVERY_SETTINGS);
  });

  it('fills the keys that are missing with their defaults', () => {
    expect(readDeliverySettings({ approach: 'kanban' })).toEqual({ ...DEFAULT_DELIVERY_SETTINGS, approach: 'kanban' });
  });

  it('keeps every valid key', () => {
    const stored = {
      approach: 'scrum',
      sprintLengthDays: 7,
      itemTypes: { naming: 'story', featureLevel: true, enabled: ['epic', 'feature', 'story'] },
      wipLimits: { todo: 3 },
      definitionOfDone: ['Reviewed'],
    };
    expect(readDeliverySettings(stored)).toEqual(stored);
  });

  it('replaces a malformed key by its default and keeps the rest', () => {
    const result = readDeliverySettings({
      approach: 'waterfall',
      sprintLengthDays: 400,
      itemTypes: { naming: 'nope' },
      wipLimits: { todo: 0 },
      definitionOfDone: [''],
    });
    expect(result).toEqual(DEFAULT_DELIVERY_SETTINGS);
    expect(readDeliverySettings({ approach: 'hybrid', sprintLengthDays: 'x' })).toMatchObject({
      approach: 'hybrid',
      sprintLengthDays: 14,
    });
  });
});

describe('request schemas', () => {
  it('accepts the delivery setting with only an approach and rejects unknown keys', () => {
    expect(deliverySettingsInputSchema.safeParse({ approach: 'scrum' }).success).toBe(true);
    expect(deliverySettingsInputSchema.safeParse({ approach: 'scrum', extra: 1 }).success).toBe(false);
    expect(deliverySettingsInputSchema.safeParse({ approach: 'scrum', sprintLengthDays: 43 }).success).toBe(false);
    expect(deliverySettingsInputSchema.safeParse({ approach: 'scrum', wipLimits: { a: 1000 } }).success).toBe(false);
  });

  it('trims a definition of done item and refuses an empty one', () => {
    const ok = deliverySettingsInputSchema.parse({ approach: 'scrum', definitionOfDone: ['  Tested  '] });
    expect(ok.definitionOfDone).toEqual(['Tested']);
    expect(deliverySettingsInputSchema.safeParse({ approach: 'scrum', definitionOfDone: ['  '] }).success).toBe(false);
  });

  it('validates sprints', () => {
    expect(createSprintInputSchema.safeParse({ projectId: 'p1', name: 'S1' }).success).toBe(true);
    expect(createSprintInputSchema.safeParse({ projectId: 'p1', name: '  ' }).success).toBe(false);
    expect(updateSprintInputSchema.safeParse({}).success).toBe(true);
    expect(startSprintInputSchema.safeParse({ goal: 'g' }).success).toBe(true);
    expect(startSprintInputSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it('validates completing a sprint', () => {
    expect(
      completeSprintInputSchema.safeParse({ moveTo: 'next', items: [{ taskId: 't1', moveTo: 'backlog' }] }).success,
    ).toBe(true);
    expect(completeSprintInputSchema.safeParse({ moveTo: 'elsewhere' }).success).toBe(false);
  });

  it('validates retro cards', () => {
    expect(
      createRetroCardInputSchema.safeParse({ projectId: 'p', sprintId: 's', category: 'action', text: 'Do it' }).success,
    ).toBe(true);
    expect(
      createRetroCardInputSchema.safeParse({ projectId: 'p', sprintId: 's', category: 'bogus', text: 'x' }).success,
    ).toBe(false);
    expect(updateRetroCardInputSchema.safeParse({ text: '' }).success).toBe(false);
    expect(updateRetroCardInputSchema.safeParse({}).success).toBe(true);
  });

  it('parses a sprint report', () => {
    const pts = { points: 1, count: 1 };
    const report = {
      committed: { ...pts, taskIds: ['a'] },
      completed: pts,
      added: pts,
      removed: pts,
      carriedOver: { ...pts, taskIds: [], toSprintId: null, toBacklog: 0 },
      goalMet: null,
      burndown: [{ date: '2026-11-01', remaining: null, ideal: 3 }],
    };
    expect(sprintReportSchema.safeParse(report).success).toBe(true);
  });
});
