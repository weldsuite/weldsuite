/**
 * Builders for the Backlog and epic page tests: items, sprints, epics, the
 * delivery model of an approach, the shared context and a render helper with
 * the providers the screens need.
 */

import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { EpicRollup, Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import type { BacklogItem } from '@/app/weldflow/lib/backlog';
import { deliveryModel } from '@/app/weldflow/lib/delivery';
import type { BacklogEnv } from './backlog-context';

export function makeItem(over: Partial<BacklogItem> & { id: string }): BacklogItem {
  return {
    number: null,
    title: `Item ${over.id}`,
    type: 'story',
    status: 'todo',
    priority: 'medium',
    sprintId: null,
    epicId: null,
    storyPoints: null,
    assigneeId: null,
    assigneeName: null,
    assigneeAvatar: null,
    position: 0,
    createdAt: '2026-10-01T08:00:00.000Z',
    completedDate: null,
    ...over,
  };
}

export function makeSprint(over: Partial<Sprint> & { id: string }): Sprint {
  return {
    projectId: 'p1',
    name: `Sprint ${over.id}`,
    goal: null,
    status: 'planned',
    startDate: null,
    endDate: null,
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}

export function makeEpic(over: Partial<EpicRollup> & { id: string }): EpicRollup {
  return { title: `Epic ${over.id}`, type: 'epic', status: 'todo', items: 0, done: 0, points: 0, donePoints: 0, ...over };
}

/** The delivery model the hooks return for a project on this approach. */
export function deliveryFor(approach: 'scrum' | 'kanban' | 'tasklist', available = true) {
  return { ...deliveryModel({ delivery: { approach } }, available), isLoading: false };
}

export function makeEnv(over: Partial<BacklogEnv> = {}): BacklogEnv {
  const selected = over.selected ?? new Set<string>();
  return {
    projectId: 'p1',
    canWrite: true,
    naming: 'pbi',
    featureLevel: false,
    usesSprints: true,
    types: ['epic', 'story', 'bug', 'task', 'spike'],
    sprints: [],
    epics: [],
    epicsById: new Map(),
    selected,
    toggleSelected: vi.fn(),
    targetsFor: (id: string) => [id],
    actions: {
      open: vi.fn(),
      changeType: vi.fn(),
      moveToSprint: vi.fn(),
      setEpic: vi.fn(),
      turnIntoEpic: vi.fn(),
      requestDelete: vi.fn(),
    },
    ...over,
  };
}

export function renderApp(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">{ui}</I18nProvider>
      </QueryClientProvider>,
    ),
  };
}
