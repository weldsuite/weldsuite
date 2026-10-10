import { describe, expect, it } from 'vitest';
import { buildStatusToStageId } from './stage-resolution';

describe('buildStatusToStageId', () => {
  const stages = [
    { id: 'stg_todo', systemStatus: 'todo' },
    { id: 'stg_prog', systemStatus: 'in_progress' },
    { id: 'blocked_3a8y', systemStatus: 'in_progress' },
    { id: 'stg_done', systemStatus: 'done' },
  ];

  it('maps a bare status to the first stage carrying it, not the last', () => {
    const map = buildStatusToStageId(stages);
    expect(map.get('in_progress')).toBe('stg_prog');
  });

  it('maps a stage id to itself, including custom stages sharing a status', () => {
    const map = buildStatusToStageId(stages);
    expect(map.get('blocked_3a8y')).toBe('blocked_3a8y');
    expect(map.get('stg_prog')).toBe('stg_prog');
  });

  it('lets a stage id win over a status of the same name', () => {
    const map = buildStatusToStageId([
      { id: 'a', systemStatus: 'done' },
      { id: 'done', systemStatus: 'done' },
    ]);
    expect(map.get('done')).toBe('done');
  });
});
