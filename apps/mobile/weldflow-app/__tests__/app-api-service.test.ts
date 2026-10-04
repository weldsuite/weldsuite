/**
 * Exercises the real `services/app-api.ts` wrapper against a fake HTTP client
 * and asserts the request path each call builds, so the paging contract with
 * app-api (cursor / page / pageSize / excludeStatus) can't silently drift.
 */

// Imports run before this line, so the fake client reaches the mock lazily.
const mockGet = jest.fn();

jest.mock('@weldsuite/api-client/client', () => ({
  ...jest.requireActual('@weldsuite/api-client/client'),
  createClientApi: jest.fn(() => ({ get: (path: string) => mockGet(path) })),
}));
jest.mock('@weldsuite/app-api-client/domains/push-tokens', () => ({
  createPushTokensApi: jest.fn(() => ({})),
}));
jest.mock('@weldsuite/app-api-client/domains/notifications', () => ({
  createNotificationsApi: jest.fn(() => ({})),
}));

import api from '@/services/app-api';

function requestedPath(): string {
  expect(mockGet).toHaveBeenCalledTimes(1);
  return mockGet.mock.calls[0][0] as string;
}

function requestedParams(): URLSearchParams {
  const path = requestedPath();
  return new URLSearchParams(path.slice(path.indexOf('?') + 1));
}

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
});

describe('listMyTasks', () => {
  it('sends the page, page size and excludeStatus of the "open" filter', async () => {
    await api.weldflow.listMyTasks({ limit: 50, page: 2, excludeStatus: 'done,cancelled' });

    expect(requestedPath()).toContain('/my-tasks?');
    const params = requestedParams();
    expect(params.get('pageSize')).toBe('50');
    expect(params.get('page')).toBe('2');
    expect(params.get('excludeStatus')).toBe('done,cancelled');
    expect(requestedPath()).toContain('excludeStatus=done%2Ccancelled');
  });

  it('forwards the due date bucket and status filters the dashboard KPIs use', async () => {
    await api.weldflow.listMyTasks({
      limit: 1,
      excludeStatus: 'done,cancelled',
      dueDateBucket: 'overdue',
    });

    const params = requestedParams();
    expect(params.get('pageSize')).toBe('1');
    expect(params.get('dueDateBucket')).toBe('overdue');
    expect(params.has('page')).toBe(false);
  });

  it('never sends a cursor: my-tasks pages by number', async () => {
    await api.weldflow.listMyTasks({ limit: 50, cursor: 'c1', status: 'todo' });

    const params = requestedParams();
    expect(params.has('cursor')).toBe(false);
    expect(params.get('status')).toBe('todo');
  });
});

describe('listProjectTasks', () => {
  it('sends both sizes and the cursor so page 2 uses keyset mode', async () => {
    await api.weldflow.listProjectTasks('p1', { limit: 50, cursor: 'c1' });

    expect(requestedPath()).toContain('/tasks?');
    const params = requestedParams();
    expect(params.get('projectId')).toBe('p1');
    expect(params.get('cursor')).toBe('c1');
    expect(params.get('limit')).toBe('50');
    expect(params.get('pageSize')).toBe('50');
  });

  it('omits the cursor on the first page', async () => {
    await api.weldflow.listProjectTasks('p1', { limit: 50 });

    const params = requestedParams();
    expect(params.has('cursor')).toBe(false);
    expect(params.get('pageSize')).toBe('50');
  });
});

describe('listProjects', () => {
  it('forwards the cursor for the next page', async () => {
    await api.weldflow.listProjects({ limit: 25, cursor: 'c1' });

    expect(requestedPath()).toContain('/projects?');
    const params = requestedParams();
    expect(params.get('limit')).toBe('25');
    expect(params.get('cursor')).toBe('c1');
  });
});

describe('listSubtasks', () => {
  it('reads the direct children of the task', async () => {
    await api.weldflow.listSubtasks('t1');

    expect(mockGet).toHaveBeenCalledWith('/tasks/t1/subtasks');
  });
});
