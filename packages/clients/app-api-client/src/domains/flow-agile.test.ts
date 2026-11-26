import { describe, expect, it } from 'vitest';
import { createFlowAgileApi } from './flow-agile';
import { RESPONSE, recordingApi, type DomainCase } from './recording-api.test-helper';

const CASES: DomainCase<ReturnType<typeof createFlowAgileApi>>[] = [
  {
    name: 'listSprints',
    call: (c) => c.listSprints({ projectId: 'p1', status: 'active', limit: 100 }),
    expected: { method: 'GET', path: '/sprints?projectId=p1&status=active&limit=100' },
  },
  { name: 'getSprint', call: (c) => c.getSprint('s1'), expected: { method: 'GET', path: '/sprints/s1' } },
  {
    name: 'createSprint',
    call: (c) => c.createSprint({ projectId: 'p1', name: 'Sprint 1' }),
    expected: { method: 'POST', path: '/sprints', body: { projectId: 'p1', name: 'Sprint 1' } },
  },
  {
    name: 'updateSprint',
    call: (c) => c.updateSprint('s1', { goal: 'ship' }),
    expected: { method: 'PATCH', path: '/sprints/s1', body: { goal: 'ship' } },
  },
  { name: 'deleteSprint', call: (c) => c.deleteSprint('s1'), expected: { method: 'DELETE', path: '/sprints/s1' } },
  {
    name: 'startSprint with input',
    call: (c) => c.startSprint('s1', { goal: 'go' }),
    expected: { method: 'POST', path: '/sprints/s1/start', body: { goal: 'go' } },
  },
  {
    name: 'startSprint defaults to an empty body',
    call: (c) => c.startSprint('s1'),
    expected: { method: 'POST', path: '/sprints/s1/start', body: {} },
  },
  {
    name: 'completeSprint with input',
    call: (c) => c.completeSprint('s1', { moveTo: 'backlog' }),
    expected: { method: 'POST', path: '/sprints/s1/complete', body: { moveTo: 'backlog' } },
  },
  {
    name: 'completeSprint defaults to an empty body',
    call: (c) => c.completeSprint('s1'),
    expected: { method: 'POST', path: '/sprints/s1/complete', body: {} },
  },
  { name: 'getSprintReport', call: (c) => c.getSprintReport('s1'), expected: { method: 'GET', path: '/sprints/s1/report' } },
  { name: 'listEpics', call: (c) => c.listEpics('p1'), expected: { method: 'GET', path: '/tasks/epics?projectId=p1' } },
  {
    name: 'updateTaskAgile',
    call: (c) => c.updateTaskAgile('t1', { type: 'bug', storyPoints: 3 }),
    expected: { method: 'PATCH', path: '/tasks/t1', body: { type: 'bug', storyPoints: 3 } },
  },
  {
    name: 'updateDelivery',
    call: (c) => c.updateDelivery('p1', { approach: 'scrum' }),
    expected: { method: 'PUT', path: '/projects/p1/delivery', body: { approach: 'scrum' } },
  },
  {
    name: 'listRetroCards',
    call: (c) => c.listRetroCards('p1', 's1'),
    expected: { method: 'GET', path: '/project-lessons?projectId=p1&sprintId=s1&limit=100' },
  },
  {
    name: 'createRetroCard',
    call: (c) => c.createRetroCard({ projectId: 'p1', sprintId: 's1', category: 'action', text: 'x' }),
    expected: {
      method: 'POST',
      path: '/project-lessons',
      body: { projectId: 'p1', sprintId: 's1', category: 'action', text: 'x' },
    },
  },
  {
    name: 'updateRetroCard',
    call: (c) => c.updateRetroCard('r1', { text: 'y' }),
    expected: { method: 'PATCH', path: '/project-lessons/r1', body: { text: 'y' } },
  },
  { name: 'deleteRetroCard', call: (c) => c.deleteRetroCard('r1'), expected: { method: 'DELETE', path: '/project-lessons/r1' } },
  {
    name: 'voteRetroCard',
    call: (c) => c.voteRetroCard('r1'),
    expected: { method: 'POST', path: '/project-lessons/r1/vote', body: {} },
  },
  {
    name: 'unvoteRetroCard',
    call: (c) => c.unvoteRetroCard('r1'),
    expected: { method: 'DELETE', path: '/project-lessons/r1/vote' },
  },
];

describe('createFlowAgileApi', () => {
  it.each(CASES)('$name sends the right request', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    const result = await call(createFlowAgileApi(api));
    expect(calls).toEqual([expected]);
    expect(result).toBe(RESPONSE);
  });
});
