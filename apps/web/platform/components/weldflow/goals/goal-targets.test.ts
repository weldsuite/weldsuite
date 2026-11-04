import { describe, expect, it } from 'vitest';
import type { GoalTargetProgress } from '@weldsuite/app-api-client/domains/project-governance';
import { progressFromTargets } from './goal-targets';

const target = (progressPct: number | null): GoalTargetProgress => ({
  index: 0,
  kind: 'task',
  label: 'x',
  benefitId: null,
  code: null,
  metric: null,
  unit: null,
  baselineValue: null,
  currentValue: null,
  targetValue: null,
  status: null,
  done: null,
  total: null,
  progressPct,
});

describe('progressFromTargets', () => {
  it('averages the targets whose progress can be told', () => {
    expect(progressFromTargets([target(8), target(50), target(null)])).toBe(29);
    expect(progressFromTargets([target(100)])).toBe(100);
  });
  it('is null when nothing can be told', () => {
    expect(progressFromTargets([target(null)])).toBeNull();
    expect(progressFromTargets([])).toBeNull();
    expect(progressFromTargets(undefined)).toBeNull();
  });
});
