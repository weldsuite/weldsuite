/**
 * Exercises the real `services/app-api.ts` wrapper against a fake HTTP client
 * and asserts the request path each call builds, so the paging contract with
 * app-api (cursor / page / pageSize / excludeStatus) can't silently drift.
 */

// Imports run before this line, so the fake client reaches the mock lazily.
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();

jest.mock('@weldsuite/api-client/client', () => ({
  ...jest.requireActual('@weldsuite/api-client/client'),
  createClientApi: jest.fn(() => ({
    get: (path: string) => mockGet(path),
    post: (path: string, data?: unknown) => mockPost(path, data),
    delete: (path: string) => mockDelete(path),
  })),
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

describe('time tracking', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: {} });
    mockDelete.mockReset();
    mockDelete.mockResolvedValue({});
  });

  it('reads the running timer', async () => {
    await api.weldflow.getRunningTimer();

    expect(mockGet).toHaveBeenCalledWith('/time-entries/timer');
  });

  it('starts, stops and discards the timer on the timer routes', async () => {
    await api.weldflow.startTimer({ projectId: 'p1', taskId: 't1' });
    await api.weldflow.stopTimer({ timeZone: 'Europe/Amsterdam' });
    await api.weldflow.discardTimer();

    expect(mockPost).toHaveBeenNthCalledWith(1, '/time-entries/timer/start', {
      projectId: 'p1',
      taskId: 't1',
    });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/time-entries/timer/stop', {
      timeZone: 'Europe/Amsterdam',
    });
    expect(mockDelete).toHaveBeenCalledWith('/time-entries/timer');
  });

  it('lists own entries for a week', async () => {
    await api.weldflow.listTimeEntries({ fromDate: '2026-11-02', toDate: '2026-11-08', limit: 500 });

    expect(requestedPath()).toContain('/time-entries?');
    const params = requestedParams();
    expect(params.get('fromDate')).toBe('2026-11-02');
    expect(params.get('toDate')).toBe('2026-11-08');
    expect(params.get('limit')).toBe('500');
    expect(params.has('scope')).toBe(false);
  });

  it('logs time in minutes', async () => {
    await api.weldflow.createTimeEntry({ taskId: 't1', projectId: 'p1', date: '2026-11-03', duration: 90 });

    expect(mockPost).toHaveBeenCalledWith('/time-entries', {
      taskId: 't1',
      projectId: 'p1',
      date: '2026-11-03',
      duration: 90,
    });
  });
});
