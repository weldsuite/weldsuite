import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketLabel, planChartQuery, type ChartQueryParams } from './analytics-query';

const base: ChartQueryParams = {
  entity: 'tasks',
  metric: 'total_tasks',
  timeRange: 'last_30_days',
  groupBy: 'day',
  aggregation: 'sum',
};

describe('planChartQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('rejects entities and metrics it does not know', () => {
    expect(() => planChartQuery('ws_1', { ...base, entity: 'nope' })).toThrow('Unknown entity');
    expect(() => planChartQuery('ws_1', { ...base, metric: 'nope' })).toThrow('Unknown metric');
  });

  it('only ever interpolates an integer, bounded limit', () => {
    const grouped = { ...base, groupBy: 'status', metric: 'count' };
    const sql = (limit: unknown) => planChartQuery('ws_1', { ...grouped, limit: limit as number }).queries[0]!;

    expect(sql(5)).toMatch(/ LIMIT 5$/);
    expect(sql(1e9)).toMatch(/ LIMIT 1000$/);
    expect(sql('5; DROP TABLE x')).not.toContain('LIMIT');
    expect(sql(2.5)).not.toContain('LIMIT');
    expect(sql(-3)).not.toContain('LIMIT');
  });

  it('escapes the workspace id and drops unusable project ids', () => {
    const [sql] = planChartQuery("ws_'1", { ...base, projectIds: ['proj_a', "x' OR '1'='1"] }).queries;
    expect(sql).toContain("workspace_id = 'ws_''1'");
    expect(sql).toContain("project_id IN ('proj_a')");
    expect(sql).not.toContain("OR '1'");
  });

  it('answers nothing, without a query, when no project is visible', () => {
    expect(planChartQuery('ws_1', { ...base, projectIds: [] }).queries).toEqual([]);
    expect(planChartQuery('ws_1', { ...base, projectIds: ['proj_a'], projectId: 'proj_b' }).queries).toEqual([]);
  });

  it('scopes a single project, matching the project row itself for the project entity', () => {
    const [tasks] = planChartQuery('ws_1', { ...base, projectId: 'proj_a' }).queries;
    expect(tasks).toContain("project_id IN ('proj_a')");
    const [projects] = planChartQuery('ws_1', { ...base, entity: 'projects', metric: 'total_projects', projectId: 'proj_a' })
      .queries;
    expect(projects).toContain("entity_id IN ('proj_a')");
  });

  it('supports every period the builder offers', () => {
    const range = (timeRange: string) => {
      const [sql] = planChartQuery('ws_1', { ...base, timeRange }).queries;
      return [/event_date >= '([^']+)'/.exec(sql!)?.[1], /event_date <= '([^']+)'/.exec(sql!)?.[1]];
    };
    expect(range('today')).toEqual(['2026-10-16', '2026-10-16']);
    expect(range('yesterday')).toEqual(['2026-10-15', '2026-10-15']);
    expect(range('last_year')).toEqual(['2025-01-01', '2025-12-31']);
    expect(range('all_time')).toEqual(['1970-01-01', '2026-10-16']);
    expect(range('this_month')).toEqual(['2026-10-01', '2026-10-16']);
    expect(range('something_else')).toEqual(['2026-09-16', '2026-10-16']);
  });

  it('queries per day for week/month/quarter/year and rolls the days up', () => {
    const plan = planChartQuery('ws_1', { ...base, groupBy: 'month', limit: 12 });
    expect(plan.queries[0]).toContain('GROUP BY event_date');
    expect(plan.queries[0]).not.toContain('LIMIT');

    const points = plan.finish([
      [
        ['2026-09-30', 2],
        ['2026-10-01', 3],
        ['2026-10-10', 4],
      ],
    ]);
    expect(points).toEqual([
      { label: '2026-09', value: 2 },
      { label: '2026-10', value: 7 },
    ]);
  });

  it('treats hourly grouping as daily (rows only carry a date)', () => {
    const [sql] = planChartQuery('ws_1', { ...base, groupBy: 'hour' }).queries;
    expect(sql).toContain('GROUP BY event_date');
  });

  it('applies the calculation to measure metrics only', () => {
    const select = (metric: string, aggregation: string) =>
      planChartQuery('ws_1', { ...base, metric, aggregation, groupBy: 'status' }).queries[0]!.split(' FROM ')[0];

    expect(select('total_hours', 'sum')).toBe('SELECT status, SUM(actual_hours)');
    expect(select('total_hours', 'average')).toBe('SELECT status, AVG(actual_hours)');
    expect(select('total_hours', 'max')).toBe('SELECT status, MAX(actual_hours)');
    expect(select('total_hours', 'min')).toBe('SELECT status, MIN(actual_hours)');
    expect(select('total_hours', 'count')).toBe('SELECT status, SUM(count)');
    // An event counter has nothing to average.
    expect(select('total_tasks', 'average')).toBe('SELECT status, SUM(count)');
  });

  it('rolls maximums, minimums and weighted averages up correctly', () => {
    const days: [string, number, number][] = [
      ['2026-10-05', 10, 1],
      ['2026-10-06', 20, 3],
    ];
    const run = (aggregation: string) =>
      planChartQuery('ws_1', { ...base, metric: 'total_hours', groupBy: 'month', aggregation }).finish([
        days.map(([d, v, w]) => [d, v, w]),
      ]);

    expect(run('max')).toEqual([{ label: '2026-10', value: 20 }]);
    expect(run('min')).toEqual([{ label: '2026-10', value: 10 }]);
    expect(run('average')).toEqual([{ label: '2026-10', value: 17.5 }]);
  });

  it('keeps the most recent days when a time series has a limit', () => {
    const plan = planChartQuery('ws_1', { ...base, limit: 2 });
    expect(plan.queries[0]).toContain('ORDER BY event_date DESC LIMIT 2');
    const points = plan.finish([
      [
        ['2026-10-15', 5],
        ['2026-10-16', 6],
      ],
    ]);
    expect(points.map((p) => p.label)).toEqual(['2026-10-15', '2026-10-16']);
  });

  describe('ratio metrics', () => {
    it('estimation accuracy divides actual by estimated hours over estimated tasks', () => {
      const plan = planChartQuery('ws_1', { ...base, metric: 'estimation_accuracy', groupBy: 'status' });
      expect(plan.queries).toHaveLength(1);
      expect(plan.queries[0]).toContain('SUM(actual_hours), SUM(estimated_hours)');
      expect(plan.queries[0]).toContain('estimated_hours > 0');

      expect(
        plan.finish([
          [
            ['done', 15, 10],
            ['todo', 4, 0],
          ],
        ]),
      ).toEqual([
        // Ordered by value, ascending by default; no estimate means 0.
        { label: 'todo', value: 0 },
        { label: 'done', value: 150 },
      ]);
    });

    it('on-time milestones compare completed-and-not-overdue with all completed', () => {
      const plan = planChartQuery('ws_1', { ...base, entity: 'milestones', metric: 'on_time_milestones' });
      expect(plan.queries).toHaveLength(2);
      expect(plan.queries[0]).toContain('is_overdue = 0');
      expect(plan.queries[1]).not.toContain('is_overdue');

      expect(plan.finish([[['2026-10-01', 3]], [['2026-10-01', 4]]])).toEqual([{ label: '2026-10-01', value: 75 }]);
    });

    it('rolls both sides up before dividing', () => {
      const plan = planChartQuery('ws_1', { ...base, metric: 'estimation_accuracy', groupBy: 'month' });
      expect(
        plan.finish([
          [
            ['2026-10-01', 10, 10],
            ['2026-10-02', 0, 10],
          ],
        ]),
      ).toEqual([{ label: '2026-10', value: 50 }]);
    });

    it('utilization rate is billable hours over all hours', () => {
      const plan = planChartQuery('ws_1', { ...base, entity: 'time_entries', metric: 'utilization_rate', groupBy: 'status' });
      expect(plan.queries[0]).toContain('is_billable = 1');
      expect(plan.finish([[['draft', 6]], [['draft', 8]]])).toEqual([{ label: 'draft', value: 75 }]);
    });
  });
});

describe('bucketLabel', () => {
  it('buckets days chronologically', () => {
    expect(bucketLabel('2026-10-16', 'day')).toBe('2026-10-16');
    // 2026-10-16 is a Friday; its ISO week starts Monday the 12th.
    expect(bucketLabel('2026-10-16', 'week')).toBe('2026-10-12');
    expect(bucketLabel('2026-10-16', 'month')).toBe('2026-10');
    expect(bucketLabel('2026-10-16', 'quarter')).toBe('2026-Q4');
    expect(bucketLabel('2026-01-01', 'quarter')).toBe('2026-Q1');
    expect(bucketLabel('2026-10-16', 'year')).toBe('2026');
  });

  it('leaves values that are not dates alone', () => {
    expect(bucketLabel('done', 'month')).toBe('done');
  });
});
