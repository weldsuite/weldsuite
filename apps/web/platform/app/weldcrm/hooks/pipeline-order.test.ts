import { describe, it, expect } from 'vitest';
import { sortPipelines } from './pipeline-order';

describe('sortPipelines', () => {
  it('lists the oldest pipeline first, whatever order the response came in', () => {
    const response = [
      { id: 'pl_c', name: 'Copy', createdAt: '2026-10-08T10:00:03.000Z' },
      { id: 'pl_a', name: 'Sales E2E', createdAt: '2026-10-08T10:00:01.000Z' },
      { id: 'pl_b', name: 'QA Verify Pipeline', createdAt: '2026-10-08T10:00:02.000Z' },
    ];
    expect(sortPipelines(response).map((p) => p.name)).toEqual(['Sales E2E', 'QA Verify Pipeline', 'Copy']);
  });

  it('matches where an in-session create is appended, so a reload does not reorder the sidebar', () => {
    const fetched = [
      { id: 'pl_a', createdAt: '2026-10-08T10:00:01.000Z' },
      { id: 'pl_b', createdAt: '2026-10-08T10:00:02.000Z' },
    ];
    const created = { id: 'pl_c', createdAt: '2026-10-08T10:00:03.000Z' };
    const sidebarBeforeReload = [...sortPipelines(fetched), created];
    const afterReload = sortPipelines([created, ...fetched].reverse());
    expect(afterReload.map((p) => p.id)).toEqual(sidebarBeforeReload.map((p) => p.id));
  });

  it('breaks ties by id and does not mutate its input', () => {
    const input = [
      { id: 'pl_2', createdAt: '2026-10-08T10:00:00.000Z' },
      { id: 'pl_1', createdAt: '2026-10-08T10:00:00.000Z' },
    ];
    expect(sortPipelines(input).map((p) => p.id)).toEqual(['pl_1', 'pl_2']);
    expect(input.map((p) => p.id)).toEqual(['pl_2', 'pl_1']);
  });

  it('puts a pipeline without a usable date last, in id order', () => {
    const sorted = sortPipelines([
      { id: 'pl_z', createdAt: undefined },
      { id: 'pl_dated', createdAt: '2026-10-08T10:00:00.000Z' },
      { id: 'pl_y', createdAt: 'not a date' },
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['pl_dated', 'pl_y', 'pl_z']);
  });
});
