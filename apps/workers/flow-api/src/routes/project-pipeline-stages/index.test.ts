import { describe, expect, it } from 'vitest';
import { positionForNewStage } from './index';

const defaults = [
  { position: 0, systemStatus: 'backlog' },
  { position: 1, systemStatus: 'todo' },
  { position: 2, systemStatus: 'in_progress' },
  { position: 3, systemStatus: 'review' },
  { position: 4, systemStatus: 'done' },
  { position: 5, systemStatus: 'cancelled' },
];

describe('positionForNewStage', () => {
  it('puts an open status before the first closed one and asks to shift the rest', () => {
    expect(positionForNewStage(defaults, 'in_progress')).toEqual({ position: 4, shiftFrom: 4 });
  });

  it('appends a closed status at the end', () => {
    expect(positionForNewStage(defaults, 'done')).toEqual({ position: 6, shiftFrom: null });
    expect(positionForNewStage(defaults, 'cancelled')).toEqual({ position: 6, shiftFrom: null });
  });

  it('appends an open status when no stage is closed', () => {
    expect(positionForNewStage(defaults.slice(0, 4), 'todo')).toEqual({ position: 4, shiftFrom: null });
  });

  it('starts at 0 for a project without stages', () => {
    expect(positionForNewStage([], 'todo')).toEqual({ position: 0, shiftFrom: null });
  });

  it('treats a custom status id as open', () => {
    expect(positionForNewStage(defaults, 'blocked_3a8y')).toEqual({ position: 4, shiftFrom: 4 });
  });
});
