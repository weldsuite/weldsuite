import { mapTask, taskPayload, tasksApi } from '@/services/tasks';
import { appApiClient } from '@/services/app-api';

jest.mock('@/services/app-api', () => ({
  appApiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const client = appApiClient as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

const row = {
  id: 'task_1',
  number: 12,
  title: 'Call Acme',
  status: 'in-progress',
  priority: 'high',
  dueDate: '2026-10-23T12:00:00.000Z',
  labels: ['vip'],
  assignees: [{ id: 'user_1', name: 'Gert', avatar: null }],
  customerId: 'cmp_1',
  linkedCompany: { id: 'cmp_1', name: 'Acme' },
  createdAt: '2026-10-22T10:00:00.000Z',
};

describe('mapTask', () => {
  it('maps the flow-api row, normalising legacy statuses', () => {
    expect(mapTask(row)).toMatchObject({
      id: 'task_1',
      status: 'in_progress',
      completed: false,
      priority: 'high',
      labels: ['vip'],
      assignees: [{ id: 'user_1', name: 'Gert' }],
      record: { kind: 'company', id: 'cmp_1', name: 'Acme' },
    });
  });

  it('links a person and treats done as completed', () => {
    const task = mapTask({ ...row, status: 'done', customerId: null, linkedCompany: null, personId: 'per_1', linkedPerson: { id: 'per_1', name: 'Jane' } });
    expect(task.completed).toBe(true);
    expect(task.record).toEqual({ kind: 'person', id: 'per_1', name: 'Jane' });
  });

  it('falls back to the single assignee and drops unknown priorities', () => {
    const task = mapTask({ ...row, assignees: [], assignee: { id: 'user_2', name: 'Sam' }, priority: 'critical' });
    expect(task.assignees).toEqual([{ id: 'user_2', name: 'Sam', avatarUrl: undefined }]);
    expect(task.priority).toBeUndefined();
  });
});

describe('taskPayload', () => {
  it('creates with a company link and leaves empties out', () => {
    expect(
      taskPayload(
        { title: ' Call ', description: ' ', priority: null, dueDate: null, assigneeIds: [], record: { kind: 'company', id: 'cmp_1' } },
        'create',
      ),
    ).toEqual({ title: 'Call', customerId: 'cmp_1' });
  });

  it('clears fields with null on update and switches the link', () => {
    expect(
      taskPayload(
        { description: '', dueDate: null, repeat: null, assigneeIds: [], record: { kind: 'person', id: 'per_1' } },
        'update',
      ),
    ).toEqual({ description: null, dueDate: null, repeat: null, assigneeIds: null, customerId: null, personId: 'per_1' });
  });
});

describe('tasksApi', () => {
  it('lists CRM-linked tasks, mine when asked', async () => {
    client.get.mockResolvedValue({ data: [row], pagination: { totalCount: 1, hasMore: false, cursor: null } });
    const res = await tasksApi.list({ assigneeId: 'user_1', search: ' acme ' });
    expect(client.get).toHaveBeenCalledWith(
      '/tasks?crmLinked=true&limit=100&search=acme&assigneeId=user_1&sortField=dueDate&sortDirection=asc',
    );
    expect(res.data?.items[0].title).toBe('Call Acme');
  });

  it("lists a record's tasks", async () => {
    client.get.mockResolvedValue({ data: [] });
    await tasksApi.list({ record: { kind: 'person', id: 'per_1' } });
    expect(client.get).toHaveBeenCalledWith('/tasks?crmLinked=true&limit=100&personId=per_1&sortField=dueDate&sortDirection=asc');
  });

  it('creates with a 30 minute calendar block, like the web', async () => {
    client.post.mockResolvedValue({ data: row });
    await tasksApi.create({ title: 'Call', record: { kind: 'company', id: 'cmp_1' } });
    expect(client.post).toHaveBeenCalledWith('/tasks', { duration: 30, title: 'Call', customerId: 'cmp_1' });
  });

  it('reads a task back after saving it', async () => {
    client.patch.mockResolvedValue({ data: { id: 'task_1' } });
    client.get.mockResolvedValue({ data: { ...row, status: 'done' } });
    const res = await tasksApi.update('task_1', { status: 'done' });
    expect(client.patch).toHaveBeenCalledWith('/tasks/task_1', { status: 'done' });
    expect(res.data?.completed).toBe(true);
  });
});
