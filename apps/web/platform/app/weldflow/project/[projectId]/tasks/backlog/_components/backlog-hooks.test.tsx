import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { DragEndEvent } from '@dnd-kit/core';
import { makeItem, makeSprint, makeEpic } from './backlog-test-fixtures';
import { useBacklogData } from './use-backlog-data';
import { useBacklogDnd } from './use-backlog-dnd';

const m = vi.hoisted(() => ({
  items: { data: undefined as unknown },
  sprints: { data: undefined as unknown },
  epics: { data: undefined as unknown },
  updateAgile: vi.fn(),
  reorder: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock('@/hooks/queries/use-flow-agile-backlog-queries', () => ({
  agileBacklogKeys: { items: (id: string) => ['items', id] },
  useBacklogItems: () => m.items,
  useReorderItems: () => ({ mutateAsync: m.reorder }),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectSprints: () => m.sprints,
  useProjectEpics: () => m.epics,
  useUpdateTaskAgile: () => ({ mutateAsync: m.updateAgile }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.updateAgile.mockResolvedValue(undefined);
  m.reorder.mockResolvedValue(undefined);
});

const EMPTY = { epicId: null, search: '', type: null };

describe('useBacklogData', () => {
  it('lays the items out in the active sprint, the planned ones and the backlog', () => {
    m.items = {
      data: [
        makeItem({ id: 'a', sprintId: 's1', position: 1 }),
        makeItem({ id: 'b', sprintId: 's2', position: 1 }),
        makeItem({ id: 'c', position: 1 }),
      ],
    };
    m.sprints = {
      data: [
        makeSprint({ id: 's3', name: 'Sprint 3', startDate: '2026-12-01T00:00:00.000Z' }),
        makeSprint({ id: 's2', name: 'Sprint 2', startDate: '2026-11-15T00:00:00.000Z' }),
        makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' }),
        makeSprint({ id: 's0', name: 'Sprint 0', status: 'completed', velocity: 10, storyPointsCompleted: 10 }),
        makeSprint({ id: 'sx', name: 'Sprint X', startDate: '2026-11-15T00:00:00.000Z' }),
      ],
    };
    m.epics = { data: [makeEpic({ id: 'e1' })] };
    const { result } = renderHook(() =>
      useBacklogData({ projectId: 'p1', available: true, usesSprints: true, enabledTypes: ['epic', 'story', 'bug'], filter: EMPTY }),
    );
    expect(result.current.activeSprint?.id).toBe('s1');
    expect(result.current.plannedSprints.map((sprint) => sprint.id)).toEqual(['s2', 'sx', 's3']);
    expect(result.current.openSprints[0]?.id).toBe('s1');
    expect(result.current.sections.s1?.map((item) => item.id)).toEqual(['a']);
    expect(result.current.backlogItems.map((item) => item.id)).toEqual(['c']);
    expect(result.current.itemsById.get('b')?.id).toBe('b');
    expect(result.current.epicsById.get('e1')?.id).toBe('e1');
    expect(result.current.types).toContain('bug');
    expect(result.current.forecast).toBe(10);
  });

  it('has no sprint sections on a project without sprints, and copes with no data', () => {
    m.items = { data: undefined };
    m.sprints = { data: undefined };
    m.epics = { data: undefined };
    const { result } = renderHook(() =>
      useBacklogData({ projectId: 'p1', available: true, usesSprints: false, enabledTypes: ['story'], filter: EMPTY }),
    );
    expect(result.current.items).toEqual([]);
    expect(result.current.openSprints).toEqual([]);
    expect(result.current.activeSprint).toBeUndefined();
    expect(result.current.backlogItems).toEqual([]);
  });
});

describe('useBacklogDnd', () => {
  const items = [
    makeItem({ id: 'a', title: 'Alpha', sprintId: 's1' }),
    makeItem({ id: 'b', title: 'Beta', sprintId: 's1' }),
    makeItem({ id: 'c', title: 'Gamma' }),
  ];
  const sections = { s1: [items[0]!, items[1]!], backlog: [items[2]!] };
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const sprints = [makeSprint({ id: 's1', name: 'Sprint 1', status: 'active' })];

  function setup() {
    const client = new QueryClient();
    client.setQueryData(['items', 'p1'], [
      { id: 'a', sprintId: 's1', position: 0 },
      { id: 'b', sprintId: 's1', position: 1 },
      { id: 'c', position: 0 },
    ]);
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">{children}</I18nProvider>
      </QueryClientProvider>
    );
    const hook = renderHook(() => useBacklogDnd({ projectId: 'p1', sections, itemsById, allSprints: sprints }), { wrapper });
    return { client, invalidate, ...hook };
  }

  const dragEnd = (active: string, over: string | null) =>
    ({ active: { id: active }, over: over === null ? null : { id: over } }) as unknown as DragEndEvent;

  it('tracks the dragged item from start to cancel', () => {
    const { result } = setup();
    act(() => result.current.onDragStart({ active: { id: 'a' } } as never));
    expect(result.current.draggingId).toBe('a');
    act(() => result.current.onDragCancel());
    expect(result.current.draggingId).toBeNull();
  });

  it('moves an item into another section: shows it, changes the sprint and saves the order', async () => {
    const { result, client } = setup();
    act(() => result.current.onDragStart({ active: { id: 'c' } } as never));
    await act(() => result.current.onDragEnd(dragEnd('c', 'b')));
    expect(result.current.draggingId).toBeNull();
    expect(m.updateAgile).toHaveBeenCalledWith({ taskId: 'c', input: { sprintId: 's1' } });
    expect(m.reorder).toHaveBeenCalledWith(['a', 'c', 'b']);
    const cached = client.getQueryData<Array<{ id: string; sprintId?: string; position?: number }>>(['items', 'p1']);
    expect(cached?.find((task) => task.id === 'c')).toMatchObject({ sprintId: 's1', position: 1 });
  });

  it('moves an item to the backlog by dropping it on the section', async () => {
    const { result } = setup();
    await act(() => result.current.onDragEnd(dragEnd('a', 'backlog')));
    expect(m.updateAgile).toHaveBeenCalledWith({ taskId: 'a', input: { sprintId: null } });
    expect(m.reorder).toHaveBeenCalledWith(['c', 'a']);
  });

  it('only reorders within a section', async () => {
    const { result } = setup();
    await act(() => result.current.onDragEnd(dragEnd('b', 'a')));
    expect(m.updateAgile).not.toHaveBeenCalled();
    expect(m.reorder).toHaveBeenCalledWith(['b', 'a']);
  });

  it('ignores a drop on nothing, on itself, or on something unknown', async () => {
    const { result } = setup();
    await act(() => result.current.onDragEnd(dragEnd('a', null)));
    await act(() => result.current.onDragEnd(dragEnd('a', 'a')));
    await act(() => result.current.onDragEnd(dragEnd('a', 'nope')));
    expect(m.reorder).not.toHaveBeenCalled();
  });

  it('tells the user and refetches when saving fails', async () => {
    m.updateAgile.mockRejectedValueOnce(new ApiError('Not allowed', 403));
    const { result, invalidate } = setup();
    await act(() => result.current.onDragEnd(dragEnd('c', 'b')));
    expect(m.toastError).toHaveBeenCalledWith('Not allowed');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['items', 'p1'] });
    expect(m.reorder).not.toHaveBeenCalled();
  });

  it('falls back to the generic message for an unexpected failure', async () => {
    m.reorder.mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();
    await act(() => result.current.onDragEnd(dragEnd('b', 'a')));
    expect(m.toastError).toHaveBeenCalledWith('The item couldn’t be moved.');
  });

  it('announces the drag for screen readers', () => {
    const { result } = setup();
    const a = result.current.announcements;
    const active = { id: 'a' } as never;
    expect(a.onDragStart?.({ active })).toBe('Picked up Alpha. Use the arrow keys to move it, space to drop it.');
    expect(a.onDragOver?.({ active, over: { id: 'c' } as never, activatorEvent: null as never, collisions: null, delta: { x: 0, y: 0 } } as never)).toBe('Alpha is over Gamma.');
    expect(a.onDragOver?.({ active, over: { id: 's1' } as never } as never)).toBe('Alpha is over the Sprint 1 section.');
    expect(a.onDragOver?.({ active, over: { id: 'backlog' } as never } as never)).toBe('Alpha is over the Backlog section.');
    expect(a.onDragOver?.({ active, over: null } as never)).toBeUndefined();
    expect(a.onDragEnd?.({ active } as never)).toBe('Alpha was dropped.');
    expect(a.onDragCancel?.({ active } as never)).toBe('Moving Alpha was cancelled.');
    // An unknown id reads as itself.
    expect(a.onDragStart?.({ active: { id: 'zz' } } as never)).toContain('zz');
  });

  function rect(left: number, top: number, size = 100) {
    return { left, top, right: left + size, bottom: top + size, width: size, height: size };
  }
  function collide(pointer: { x: number; y: number } | null) {
    const { result } = setup();
    const boxes: Record<string, ReturnType<typeof rect>> = { s1: rect(0, 0, 400), a: rect(0, 0, 100), backlog: rect(0, 500, 200) };
    const droppableContainers = Object.entries(boxes).map(([id, box]) => ({ id, rect: { current: box }, disabled: false, data: { current: undefined }, node: { current: null }, key: id }));
    return result.current.collisionDetection({
      active: { id: 'b', data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
      collisionRect: rect(10, 10, 20),
      droppableRects: new Map(Object.entries(boxes)),
      droppableContainers,
      pointerCoordinates: pointer,
    } as never);
  }

  it('prefers the item under the pointer over its section', () => {
    expect(collide({ x: 50, y: 50 }).map((hit) => hit.id)).toEqual(['a']);
  });

  it('uses the section when the pointer is on no item', () => {
    expect(collide({ x: 300, y: 300 }).map((hit) => hit.id)).toEqual(['s1']);
  });

  it('falls back to the closest target when the pointer is outside all of them', () => {
    expect(collide({ x: 900, y: 900 }).length).toBeGreaterThan(0);
  });
});
