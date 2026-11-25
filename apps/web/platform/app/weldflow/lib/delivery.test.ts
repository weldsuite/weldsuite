import { describe, expect, it } from 'vitest';
import { averageVelocity, deliveryModel, enabledItemTypes } from './delivery';
import { DEFAULT_DELIVERY_SETTINGS, type ItemType } from '@weldsuite/app-api-client/schemas/flow-agile';

describe('deliveryModel', () => {
  it('reads a project without a delivery setting as a task list', () => {
    const model = deliveryModel({ tabs: { hidden: [] } }, true);
    expect(model.approach).toBe('tasklist');
    expect(model.isAgile).toBe(false);
    expect(model.usesSprints).toBe(false);
    expect(model.tasksOpensOn).toBe('list');
    expect(model.enabledTypes).toEqual([]);
  });

  it('turns on sprints, item types and the backlog for scrum', () => {
    const model = deliveryModel({ delivery: { approach: 'scrum' } }, true);
    expect(model.isAgile).toBe(true);
    expect(model.usesSprints).toBe(true);
    expect(model.usesItemTypes).toBe(true);
    expect(model.tasksOpensOn).toBe('backlog');
    expect(model.enabledTypes).toEqual(['epic', 'story', 'bug', 'task', 'spike', 'subtask']);
  });

  it('ignores the setting where the feature is unavailable', () => {
    const model = deliveryModel({ delivery: { approach: 'scrum' } }, false);
    expect(model.approach).toBe('tasklist');
    expect(model.available).toBe(false);
  });

  it('falls back per key on a malformed setting', () => {
    const model = deliveryModel({ delivery: { approach: 'kanban', sprintLengthDays: 'two weeks' } }, true);
    expect(model.approach).toBe('kanban');
    expect(model.settings.sprintLengthDays).toBe(14);
    expect(model.usesWipLimits).toBe(true);
  });

  it('shows WIP limits for any approach once one is set', () => {
    const model = deliveryModel({ delivery: { approach: 'scrum', wipLimits: { stg_1: 3 } } }, true);
    expect(model.usesWipLimits).toBe(true);
  });
});

describe('enabledItemTypes', () => {
  it('keeps features out unless the feature level is on', () => {
    const enabled: ItemType[] = ['feature', 'epic', 'bug'];
    const withLevel = (featureLevel: boolean) => ({
      ...DEFAULT_DELIVERY_SETTINGS,
      itemTypes: { naming: 'pbi' as const, featureLevel, enabled },
    });
    expect(enabledItemTypes(withLevel(false))).toEqual(['epic', 'bug']);
    expect(enabledItemTypes(withLevel(true))).toEqual(['epic', 'feature', 'bug']);
  });
});

describe('averageVelocity', () => {
  it('averages the last three completed sprints, newest first', () => {
    const sprints = [
      { status: 'completed', velocity: 10, completedAt: '2026-01-01T00:00:00Z' },
      { status: 'completed', velocity: 20, completedAt: '2026-02-01T00:00:00Z' },
      { status: 'completed', velocity: 30, completedAt: '2026-03-01T00:00:00Z' },
      { status: 'completed', velocity: 25, completedAt: '2026-04-01T00:00:00Z' },
      { status: 'active', velocity: null, completedAt: null },
    ];
    expect(averageVelocity(sprints)).toBe(25);
  });

  it('is null without completed sprints', () => {
    expect(averageVelocity([{ status: 'planned', velocity: null, completedAt: null }])).toBeNull();
  });
});
