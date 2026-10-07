import { describe, expect, it } from 'vitest';
import { errorLogPageCount, errorsByWorkflowChart, summarizeExecutions } from './analytics-utils';

describe('errorLogPageCount', () => {
  it('rounds up and never drops below one page', () => {
    expect(errorLogPageCount(0, 20)).toBe(1);
    expect(errorLogPageCount(20, 20)).toBe(1);
    expect(errorLogPageCount(21, 20)).toBe(2);
  });
});

describe('errorsByWorkflowChart', () => {
  it('labels bars by workflow name, falling back for deleted workflows', () => {
    expect(
      errorsByWorkflowChart(
        [
          { workflowId: 'wf_1', workflowName: 'Order sync', count: 3 },
          { workflowId: null, workflowName: null, count: 1 },
        ],
        'Deleted workflow',
      ),
    ).toEqual([
      { id: 'wf_1', name: 'Order sync', errors: 3 },
      { id: 'deleted-1', name: 'Deleted workflow', errors: 1 },
    ]);
  });
});

describe('summarizeExecutions', () => {
  it('counts queued and running as in progress, not cancelled runs', () => {
    expect(summarizeExecutions({ total: 10, completed: 6, failed: 2, running: 1, queued: 0 })).toEqual({
      totalExecutions: 10,
      successfulExecutions: 6,
      failedExecutions: 2,
      inProgressExecutions: 1,
      successRate: 60,
    });
  });

  it('reports a zero success rate without runs', () => {
    expect(summarizeExecutions({ total: 0, completed: 0, failed: 0, running: 0, queued: 0 }).successRate).toBe(0);
  });
});
