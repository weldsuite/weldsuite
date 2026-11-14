/**
 * Every spec kind through the compiler: the isolation guarantees (ADR
 * PANEL-003) are tested here, not trusted. A query that lacks the workspace
 * filter, the project filter or a time bound for ANY panel table it reads
 * (CTEs, subqueries and joins included) fails the suite.
 */

import { describe, expect, it } from 'vitest';
import {
  panelQuerySpecSchema,
  type PanelFilter,
  type ParsedPanelCohortFilter,
  type ParsedPanelQuerySpec,
  type PanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { breakdownLimitedExpr } from './scope';
import { runPanelQuery, PanelQueryError, type PanelQueryContext, type PanelSqlQuery, type RawRow } from './index';

const NOW = new Date('2026-11-14T12:00:00Z');

function ctxWith(overrides: Partial<PanelQueryContext> = {}): PanelQueryContext {
  return {
    workspaceId: 'ws_1',
    projectId: 'pnp_1',
    retentionDays: 365,
    hasIdentifiedUsers: true,
    erasedIds: [],
    now: NOW,
    ...overrides,
  };
}

const COHORT: ParsedPanelCohortFilter = {
  match: 'all',
  conditions: [
    { type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' },
    { type: 'performed', event: 'Signed up', filters: [], withinDays: 30, minCount: 1, negate: false },
    { type: 'performed', event: 'Upgraded', filters: [], withinDays: 30, minCount: 1, negate: true },
  ],
};

function parse(spec: PanelQuerySpec): ParsedPanelQuerySpec {
  return panelQuerySpecSchema.parse(spec);
}

/** Runs a spec and returns every SQL statement it sent. `canned` answers statements by name. */
async function compile(spec: PanelQuerySpec, ctx = ctxWith(), canned: Record<string, RawRow[]> = {}): Promise<PanelSqlQuery[]> {
  const sent: PanelSqlQuery[] = [];
  await runPanelQuery(parse(spec), ctx, async (query) => {
    sent.push(query);
    return { rows: canned[query.name] ?? [], bytesScanned: 10 };
  });
  return sent;
}

/** Skips the schema: what the compiler does with a spec that got past (or around) the validators. */
async function compileRaw(spec: unknown, ctx = ctxWith()): Promise<PanelSqlQuery[]> {
  const sent: PanelSqlQuery[] = [];
  await runPanelQuery(spec as ParsedPanelQuerySpec, ctx, async (query) => {
    sent.push(query);
    return { rows: [] };
  });
  return sent;
}

const TABLE_REF = /\bpanel\.(events_v1|identities_v1|people_v1|replay_chunks_v1)\b/g;
const WORKSPACE = /\bworkspace_id = 'ws_1'/g;
const PROJECT = /\bproject_id = 'pnp_1'/g;
const LOWER_BOUND = /\b(?:ts|ts_start) >= TIMESTAMP '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/g;
const UPPER_BOUND = /\b(?:ts|ts_start) (?:<|<=) TIMESTAMP '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/g;

/** Every reference to a panel table has its own workspace filter, project filter and time range. */
function expectScoped(sql: string): void {
  const refs = sql.match(TABLE_REF)?.length ?? 0;
  expect(refs, `no panel table in: ${sql}`).toBeGreaterThan(0);
  expect(sql.match(WORKSPACE)?.length ?? 0, `workspace filter per table reference in: ${sql}`).toBe(refs);
  expect(sql.match(PROJECT)?.length ?? 0, `project filter per table reference in: ${sql}`).toBe(refs);
  expect(sql.match(LOWER_BOUND)?.length ?? 0, `lower time bound per table reference in: ${sql}`).toBe(refs);
  expect(sql.match(UPPER_BOUND)?.length ?? 0, `upper time bound per table reference in: ${sql}`).toBe(refs);
  expect(sql, 'other workspaces').not.toMatch(/workspace_id (?:<>|!=|IN|LIKE)/);
}

const PROJECT_ID = 'pnp_1';
const FILTERS: PanelFilter[] = [
  { source: 'column', field: 'country', operator: 'in', value: ['NL', 'BE'] },
  { source: 'event', key: 'plan', operator: 'eq', value: 'pro' },
  { source: 'person', key: '$email', operator: 'contains', value: '@example.com' },
  { source: 'cohort', cohortId: 'pnc_1' },
];
const WITH_COHORT = { cohorts: { pnc_1: COHORT } };

const SPECS: Record<string, PanelQuerySpec> = {
  web: { kind: 'web', projectId: PROJECT_ID, dateRange: { preset: '30d' }, filters: FILTERS, compare: true },
  'web (hour, no filters)': { kind: 'web', projectId: PROJECT_ID, dateRange: { preset: 'today' } },
  trends: {
    kind: 'trends',
    projectId: PROJECT_ID,
    dateRange: { from: '2026-10-01', to: '2026-10-31' },
    timezone: 'Europe/Amsterdam',
    filters: FILTERS,
    series: [
      { event: '$pageview', math: 'unique_users' },
      { event: 'Purchase', math: 'sum', property: 'amount', filters: [{ source: 'event', key: 'currency', operator: 'eq', value: 'EUR' }] },
      { event: 'Purchase', math: 'avg_per_user' },
    ],
    interval: 'week',
    breakdown: { source: 'person', key: 'plan', limit: 5 },
    compare: true,
  },
  'trends (column breakdown)': {
    kind: 'trends',
    projectId: PROJECT_ID,
    dateRange: { preset: '7d' },
    series: [{ event: '$pageview' }],
    breakdown: { source: 'column', field: 'country' },
  },
  funnel: {
    kind: 'funnel',
    projectId: PROJECT_ID,
    dateRange: { preset: '90d' },
    filters: FILTERS,
    steps: [
      { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }] },
      { event: 'Signed up' },
      { event: 'Added to cart' },
      { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'is_set' }] },
    ],
    window: { value: 7, unit: 'day' },
    breakdown: { source: 'event', key: 'plan' },
  },
  'funnel (strict)': {
    kind: 'funnel',
    projectId: PROJECT_ID,
    dateRange: { preset: '30d' },
    steps: [{ event: 'Signed up' }, { event: 'Signed up' }, { event: 'Purchase' }],
    order: 'strict',
    window: { value: 30, unit: 'minute' },
  },
  retention: {
    kind: 'retention',
    projectId: PROJECT_ID,
    dateRange: { preset: '90d' },
    filters: FILTERS,
    firstEvent: 'Signed up',
    returnEvent: 'Login',
    interval: 'week',
    periods: 8,
  },
  'retention (month, any return)': {
    kind: 'retention',
    projectId: PROJECT_ID,
    dateRange: { preset: '12m' },
    timezone: 'America/New_York',
    firstEvent: '$pageview',
    interval: 'month',
    periods: 6,
  },
  flows: {
    kind: 'flows',
    projectId: PROJECT_ID,
    dateRange: { preset: '30d' },
    filters: FILTERS,
    anchor: { event: 'Purchase', filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }] },
    direction: 'before',
    depth: 4,
    scope: 'pageviews',
  },
  'flows (after, custom)': {
    kind: 'flows',
    projectId: PROJECT_ID,
    dateRange: { preset: '30d' },
    anchor: { event: '$pageview' },
    scope: 'custom',
  },
  sessions: {
    kind: 'sessions',
    projectId: PROJECT_ID,
    dateRange: { preset: '30d' },
    minDurationSeconds: 10,
    maxDurationSeconds: 600,
    pagesVisited: ['/pricing', '/checkout'],
    entryPage: '/blog',
    exitPage: '/thanks',
    countries: ['NL'],
    devices: ['mobile'],
    browsers: ['Chrome'],
    distinctId: 'user_1',
    cohortId: 'pnc_1',
    sessionIds: ['s_1', 's_2'],
    didEvents: ['Signed up'],
    notDidEvents: ['Purchase'],
    frustration: ['rage', 'dead', 'quickback', 'excessive_scroll'],
    hasErrors: true,
    favoritesOnly: true,
    hasRecording: true,
    sort: 'frustration_desc',
    limit: 25,
    cursor: 'o25',
  },
  'sessions (defaults)': { kind: 'sessions', projectId: PROJECT_ID },
  'heatmap click': {
    kind: 'heatmap',
    projectId: PROJECT_ID,
    dateRange: { preset: '30d' },
    type: 'click',
    deviceClass: 'mobile',
    pageGroupId: 'pnh_1',
  },
  'heatmap area': { kind: 'heatmap', projectId: PROJECT_ID, type: 'area', deviceClass: 'tablet', urlPattern: '/products/*' },
  'heatmap scroll': { kind: 'heatmap', projectId: PROJECT_ID, type: 'scroll', deviceClass: 'desktop', urlPattern: '/' },
};

const CONTEXTS: Record<string, Partial<PanelQueryContext>> = {
  'identified, nothing erased': {},
  'anonymous only': { hasIdentifiedUsers: false },
  'identified, erasures pending': { erasedIds: ['user_gone', "anon'_gone"] },
};

describe('every spec kind is scoped to the workspace and project, and time-bounded', () => {
  for (const [contextName, overrides] of Object.entries(CONTEXTS)) {
    for (const [name, spec] of Object.entries(SPECS)) {
      it(`${name} (${contextName})`, async () => {
        const ctx = ctxWith({
          ...WITH_COHORT,
          pageGroups: { pnh_1: '/products/*' },
          favoriteSessionIds: ['s_1'],
          ...overrides,
        });
        // The chunk lookup of the sessions list runs only when the page has rows.
        const canned: Record<string, RawRow[]> = {
          'sessions.list': [{ session_id: 's_1' }, { session_id: 's_2' }],
          'trends.breakdownValues': [{ value: 'pro', n: 3 }],
          'funnel.breakdownValues': [{ value: 'pro', n: 3 }],
        };
        const sent = await compile(spec, ctx, canned);
        expect(sent.length).toBeGreaterThan(0);
        for (const query of sent) expectScoped(query.sql);
      });
    }
  }

  it('sends every statement of every spec with its alias list', async () => {
    for (const spec of Object.values(SPECS)) {
      const sent = await compile(spec, ctxWith({ ...WITH_COHORT, pageGroups: { pnh_1: '/p/*' }, favoriteSessionIds: [] }));
      for (const query of sent) {
        expect(query.columns.length).toBeGreaterThan(0);
        expect(query.name).toMatch(/^[a-z]+\./);
      }
    }
  });
});

describe('erased ids and the identity join', () => {
  it('excludes erased ids from the events and from the identity and profile reads', async () => {
    const sent = await compile(SPECS.trends as PanelQuerySpec, ctxWith({ ...WITH_COHORT, erasedIds: ['user_gone'] }));
    const main = sent.find((q) => q.name === 'trends.series');
    expect(main?.sql).toContain("e.anon_id NOT IN ('user_gone')");
    expect(main?.sql).toContain("e.distinct_id NOT IN ('user_gone')");
    expect(main?.sql).toContain("COALESCE(e.user_id, '') NOT IN ('user_gone')");
    expect(main?.sql).toContain("user_id NOT IN ('user_gone')");
  });

  it('joins identities only for projects that have identified users', async () => {
    const spec: PanelQuerySpec = { kind: 'web', projectId: PROJECT_ID };
    const identified = await compile(spec, ctxWith({ hasIdentifiedUsers: true }));
    const anonymous = await compile(spec, ctxWith({ hasIdentifiedUsers: false }));
    expect(identified.every((q) => q.sql.includes('panel.identities_v1'))).toBe(true);
    expect(anonymous.some((q) => q.sql.includes('panel.identities_v1'))).toBe(false);
    expect(identified[0]?.sql).toContain('COALESCE(i.user_id, e.distinct_id)');
    expect(anonymous[0]?.sql).not.toContain('COALESCE(i.user_id');
  });

  it('reads the profile table only when a person property is used', async () => {
    const plain = await compile({ kind: 'web', projectId: PROJECT_ID });
    expect(plain.some((q) => q.sql.includes('panel.people_v1'))).toBe(false);
    const filtered = await compile({
      kind: 'web',
      projectId: PROJECT_ID,
      filters: [{ source: 'person', key: 'plan', operator: 'eq', value: 'pro' }],
    });
    expect(filtered.every((q) => q.sql.includes('panel.people_v1'))).toBe(true);
    expect(filtered[0]?.sql).toContain('rn = 1 AND deleted = false');
  });

  it('refuses to build a query when too many erasures are waiting', async () => {
    const erasedIds = Array.from({ length: 6000 }, (_, i) => `u_${i}`);
    await expect(compile({ kind: 'web', projectId: PROJECT_ID }, ctxWith({ erasedIds }))).rejects.toThrow(PanelQueryError);
  });
});

describe('the context decides the scope, never the spec', () => {
  it('refuses a spec for another project', async () => {
    await expect(compile({ kind: 'web', projectId: 'pnp_other' })).rejects.toThrow('different project');
  });

  it('puts the workspace from the context in every statement', async () => {
    const sent = await compile({ kind: 'web', projectId: PROJECT_ID }, ctxWith({ workspaceId: "ws_'evil" }));
    for (const query of sent) expect(query.sql).toContain("workspace_id = 'ws_''evil'");
  });

  it('refuses a cohort the context does not hold', async () => {
    await expect(
      compile({ kind: 'web', projectId: PROJECT_ID, filters: [{ source: 'cohort', cohortId: 'pnc_x' }] }),
    ).rejects.toThrow('cohort does not exist');
  });

  it('refuses a page group the context does not hold', async () => {
    await expect(
      compile({ kind: 'heatmap', projectId: PROJECT_ID, type: 'click', deviceClass: 'desktop', pageGroupId: 'pnh_x' }),
    ).rejects.toThrow('page group does not exist');
  });
});

describe('time bounds', () => {
  it('never reads further back than the retention, whatever range was asked', async () => {
    const sent = await compile(
      { kind: 'web', projectId: PROJECT_ID, dateRange: { from: '2020-01-01', to: '2026-11-14' } },
      ctxWith({ retentionDays: 30 }),
    );
    const floor = "TIMESTAMP '2026-10-15 12:00:00'";
    for (const query of sent) {
      expect(query.sql).toContain(`>= ${floor}`);
      expect(query.sql).not.toContain("TIMESTAMP '2020-");
    }
  });

  it('caps the retention at 25 months', async () => {
    const sent = await compile(
      { kind: 'web', projectId: PROJECT_ID, dateRange: { preset: '12m' } },
      ctxWith({ retentionDays: 100000 }),
    );
    expect(sent.length).toBeGreaterThan(0);
    // 762 days before 2026-11-14 is 2024-10-13: the oldest instant any table is read from.
    for (const query of sent) expect(query.sql).toContain("TIMESTAMP '2024-10-13 12:00:00'");
    for (const query of sent) expect(query.sql).not.toMatch(/TIMESTAMP '(2024-0|2024-10-0|2024-10-1[0-2]|2023|2022)/);
  });

  it('never reads into the future', async () => {
    const sent = await compile({ kind: 'web', projectId: PROJECT_ID, dateRange: { from: '2026-11-01', to: '2027-12-31' } });
    for (const query of sent) expect(query.sql).not.toContain("TIMESTAMP '2027");
  });
});

describe('values reach SQL only through the escaping function', () => {
  const evil = "x' OR '1'='1";

  it('doubles single quotes in filter values and in the breakdown', async () => {
    const sent = await compile(
      {
        kind: 'trends',
        projectId: PROJECT_ID,
        series: [{ event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: evil }] }],
        breakdown: { source: 'event', key: 'plan' },
      },
      ctxWith(),
      { 'trends.breakdownValues': [{ value: evil, n: 1 }] },
    );
    const main = sent.find((q) => q.name === 'trends.series') as PanelSqlQuery;
    expect(main.sql).toContain("e.path = 'x'' OR ''1''=''1'");
    expect(main.sql).toContain("IN ('x'' OR ''1''=''1')");
    expect(main.sql).not.toContain("= 'x' OR");
  });

  it('refuses event names that are not event names, in the schema and again in the compiler', async () => {
    for (const event of [evil, 'a;DROP TABLE x', 'name\n', '$Pageview', ' Leading']) {
      const spec = {
        kind: 'trends',
        projectId: PROJECT_ID,
        series: [{ event, math: 'total', filters: [] }],
        interval: 'day',
        compare: false,
        filters: [],
        timezone: 'UTC',
        dateRange: { preset: '7d' },
      };
      expect(() => panelQuerySpecSchema.parse(spec), `schema: ${JSON.stringify(event)}`).toThrow();
      await expect(compileRaw(spec), `compiler: ${JSON.stringify(event)}`).rejects.toThrow(PanelQueryError);
    }
  });

  it('refuses property keys that are not property keys, in the schema and again in the compiler', async () => {
    for (const key of ["a'b", 'a b', 'a.b', '1abc', '$$x', 'a'.repeat(70), '']) {
      const spec = {
        kind: 'web',
        projectId: PROJECT_ID,
        dateRange: { preset: '7d' },
        timezone: 'UTC',
        compare: false,
        limit: 10,
        filters: [{ source: 'event', key, operator: 'eq', value: 'x' }],
      };
      expect(() => panelQuerySpecSchema.parse(spec), `schema: ${JSON.stringify(key)}`).toThrow();
      await expect(compileRaw(spec), `compiler: ${JSON.stringify(key)}`).rejects.toThrow(PanelQueryError);
    }
  });

  it('refuses a column that is not a filterable column, even past the schema', async () => {
    const spec = {
      kind: 'web',
      projectId: PROJECT_ID,
      dateRange: { preset: '7d' },
      timezone: 'UTC',
      compare: false,
      limit: 10,
      filters: [{ source: 'column', field: 'workspace_id', operator: 'eq', value: 'ws_other' }],
    };
    expect(() => panelQuerySpecSchema.parse(spec)).toThrow();
    await expect(compileRaw(spec)).rejects.toThrow('Unknown column');
  });

  it('accepts the collector $-keys and custom keys', async () => {
    const sent = await compile({
      kind: 'web',
      projectId: PROJECT_ID,
      filters: [
        { source: 'event', key: '$action', operator: 'eq', value: 'click' },
        { source: 'person', key: '$email', operator: 'is_set' },
      ],
    });
    expect(sent[0]?.sql).toContain("json_get_str(e.properties, '$action') = 'click'");
    expect(sent[0]?.sql).toContain("json_contains(pp.properties, '$email')");
  });

  it('accepts every $ key the collector writes (events and profiles)', async () => {
    for (const key of ['$source', '$line', '$col', '$from', '$action', '$email', '$name', '$avatar', '$created']) {
      const sent = await compile({
        kind: 'web',
        projectId: PROJECT_ID,
        filters: [{ source: key === '$source' || key === '$line' || key === '$col' || key === '$from' || key === '$action' ? 'event' : 'person', key, operator: 'is_set' }],
      });
      expect(sent[0]?.sql).toContain(`json_contains(`);
      expect(sent[0]?.sql).toContain(`'${key}')`);
    }
  });

  it('writes backslashes and control characters in values as chr() pieces, and refuses NUL', async () => {
    const cases: Array<[string, string]> = [
      ['a\\b', "('a' || chr(92) || 'b')"],
      ['CORP\\jdoe', "('CORP' || chr(92) || 'jdoe')"],
      ['a\nb', "('a' || chr(10) || 'b')"],
      ['\\', '(chr(92))'],
      ["it's\\", "('it''s' || chr(92))"],
      ['a\u007fb', "('a' || chr(127) || 'b')"],
    ];
    for (const [value, expected] of cases) {
      const sent = await compile({ kind: 'web', projectId: PROJECT_ID, filters: [{ source: 'column', field: 'path', operator: 'eq', value }] });
      expect(sent[0]?.sql).toContain(expected);
    }
    await expect(
      compile({ kind: 'web', projectId: PROJECT_ID, filters: [{ source: 'column', field: 'path', operator: 'eq', value: 'a\u0000b' }] }),
    ).rejects.toThrow(PanelQueryError);
  });

  it('keeps an erased id with a backslash from breaking every query', async () => {
    const sent = await compile({ kind: 'web', projectId: PROJECT_ID }, ctxWith({ erasedIds: ['CORP\\jdoe'] }));
    expect(sent[0]?.sql).toContain("('CORP' || chr(92) || 'jdoe')");
  });

  it('writes breakdown values with a backslash or newline as chr() pieces', () => {
    const expr = breakdownLimitedExpr({ source: 'column', field: 'path', limit: 10 }, ['C:\\x', 'a\nb']);
    expect(expr).toContain("('C:' || chr(92) || 'x')");
    expect(expr).toContain("('a' || chr(10) || 'b')");
  });

  it('escapes LIKE wildcards in contains filters and url patterns', async () => {
    const contains = await compile({
      kind: 'web',
      projectId: PROJECT_ID,
      filters: [{ source: 'column', field: 'path', operator: 'contains', value: '50%_off!' }],
    });
    expect(contains[0]?.sql).toContain("LIKE '%50!%!_off!!%' ESCAPE '!'");

    const heat = await compile({ kind: 'heatmap', projectId: PROJECT_ID, type: 'area', deviceClass: 'desktop', urlPattern: "/a_b/%/*/c'd" });
    expect(heat.find((q) => q.name === 'heatmap.elements')?.sql).toContain("LIKE '/a!_b/!%/%/c''d' ESCAPE '!'");
  });

  it('turns numbers into numbers and refuses NaN', async () => {
    const sent = await compile({
      kind: 'web',
      projectId: PROJECT_ID,
      filters: [{ source: 'event', key: 'amount', operator: 'gt', value: 12.5 }],
    });
    expect(sent[0]?.sql).toContain("json_get_float(e.properties, 'amount') > 12.5");
    expect(() => panelQuerySpecSchema.parse({ kind: 'web', projectId: 'p', filters: [{ source: 'event', key: 'a', operator: 'gt', value: Number.NaN }] })).toThrow();
  });

  it('never interpolates a limit that is not a bounded integer', () => {
    expect(() => panelQuerySpecSchema.parse({ kind: 'web', projectId: 'p', limit: 10_000 })).toThrow();
    expect(() => panelQuerySpecSchema.parse({ kind: 'sessions', projectId: 'p', limit: 1.5 })).toThrow();
  });

  it('refuses a cursor it did not issue', async () => {
    await expect(compile({ kind: 'sessions', projectId: PROJECT_ID, cursor: "o1'; DROP" })).rejects.toThrow('Invalid cursor');
    await expect(compile({ kind: 'sessions', projectId: PROJECT_ID, limit: 100, cursor: 'o450' })).rejects.toThrow('Narrow the filters');
  });
});

describe('representative SQL', () => {
  it('trends: one scan for all series, the breakdown applied as a CASE from the first result', async () => {
    const sent = await compile(
      {
        kind: 'trends',
        projectId: PROJECT_ID,
        dateRange: { from: '2026-11-01', to: '2026-11-07' },
        series: [{ event: 'Signed up' }, { event: 'Purchase', math: 'sum', property: 'amount' }],
        breakdown: { source: 'column', field: 'country', limit: 2 },
      },
      ctxWith({ hasIdentifiedUsers: false }),
      { 'trends.breakdownValues': [{ value: 'NL', n: 9 }, { value: 'BE', n: 4 }] },
    );
    expect(sent.map((q) => q.name)).toEqual(['trends.breakdownValues', 'trends.series', 'trends.totals']);
    expect(sent[1]?.sql).toBe(
      "SELECT date_trunc('day', e.ts) AS bucket, " +
        "CASE WHEN COALESCE(CAST(e.country AS VARCHAR), '(none)') IN ('NL', 'BE') THEN COALESCE(CAST(e.country AS VARCHAR), '(none)') ELSE 'Other' END AS bd, " +
        "COUNT(CASE WHEN e.name = 'Signed up' THEN 1 END) AS s0_v, " +
        "SUM(CASE WHEN e.name = 'Purchase' THEN json_get_float(e.properties, 'amount') END) AS s1_v " +
        "FROM panel.events_v1 e WHERE e.workspace_id = 'ws_1' AND e.project_id = 'pnp_1' " +
        "AND e.ts >= TIMESTAMP '2026-11-01 00:00:00' AND e.ts < TIMESTAMP '2026-11-08 00:00:00' " +
        "AND e.name IN ('Signed up', 'Purchase') " +
        "GROUP BY date_trunc('day', e.ts), CASE WHEN COALESCE(CAST(e.country AS VARCHAR), '(none)') IN ('NL', 'BE') THEN COALESCE(CAST(e.country AS VARCHAR), '(none)') ELSE 'Other' END " +
        "ORDER BY date_trunc('day', e.ts) ASC",
    );
  });

  it('trends: buckets are cut in the timezone', async () => {
    const sent = await compile({
      kind: 'trends',
      projectId: PROJECT_ID,
      dateRange: { from: '2026-07-01', to: '2026-07-02' },
      timezone: 'Europe/Amsterdam',
      series: [{ event: '$pageview' }],
    });
    expect(sent[0]?.sql).toContain("date_trunc('day', e.ts + INTERVAL '120 minutes')");
    // Midnight in Amsterdam (UTC+2 in July) is 22:00 UTC the evening before.
    expect(sent[0]?.sql).toContain("e.ts >= TIMESTAMP '2026-06-30 22:00:00'");
  });

  it('funnel: step CTEs join the previous step, the window bounds every step', async () => {
    const sent = await compile({
      kind: 'funnel',
      projectId: PROJECT_ID,
      dateRange: { preset: '30d' },
      steps: [{ event: 'A' }, { event: 'B' }, { event: 'C' }],
      window: { value: 2, unit: 'hour' },
    });
    expect(sent).toHaveLength(1);
    const sql = sent[0]?.sql as string;
    expect(sql).toContain('WITH seq AS (');
    expect(sql).toContain("(e.name = 'A') OR (e.name = 'B') OR (e.name = 'C')");
    expect(sql).toContain('s1 AS (SELECT person, MIN(ts) AS t1');
    expect(sql).toContain('s2 AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, MIN(q.ts) AS t, MIN(p.bd) AS bd FROM s1 p JOIN seq q ON q.person = p.person');
    expect(sql).toContain("q.m3 = 1 AND q.ts >= p.t AND q.ts <= p.t1 + INTERVAL '2 hours'");
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
    // The raw table is read once, in `seq`.
    expect(sql.match(/panel\.events_v1/g)).toHaveLength(1);
  });

  it('funnel (strict): follows the next event of the person', async () => {
    const sent = await compile(SPECS['funnel (strict)'] as PanelQuerySpec);
    const sql = sent[0]?.sql as string;
    expect(sql).toContain('LEAD(e.event_id) OVER (PARTITION BY COALESCE(i.user_id, e.distinct_id)');
    expect(sql).toContain('JOIN seq q ON q.event_id = p.next_id AND q.person = p.person WHERE q.m2 = 1');
    // Two steps of the same event are not allowed to match the same event.
    expect(sql).not.toContain("(e.name = 'Signed up') OR");
  });

  it('funnel with a breakdown: each person gets the value of their first step-1 event, strict and loose', async () => {
    for (const order of ['strict', 'loose'] as const) {
      const sent = await compile(
        { kind: 'funnel', projectId: PROJECT_ID, order, steps: [{ event: 'A' }, { event: 'B' }], breakdown: { source: 'column', field: 'country' } },
        ctxWith(),
        { 'funnel.breakdownValues': [{ value: 'NL', n: 2 }, { value: 'BE', n: 1 }] },
      );
      const sql = sent.find((q) => q.name === 'funnel.steps')?.sql as string;
      const s1 = /s1 AS \(.*? FROM seq WHERE m1 = 1[^)]*\)/.exec(sql)?.[0] ?? '';
      if (order === 'strict') {
        expect(s1).toContain('FIRST_VALUE(bd) OVER (PARTITION BY person ORDER BY ts ASC, event_id ASC) AS bd');
      } else {
        expect(s1).toContain('FIRST_VALUE(bd ORDER BY ts ASC, event_id ASC) AS bd');
        expect(s1).not.toContain('MIN(bd)');
      }
      // Later steps carry the person's value along, never the event's own.
      expect(sql).toContain(order === 'strict' ? 'p.bd AS bd' : 'MIN(p.bd) AS bd');
    }
  });

  it('funnel: same event twice in a row needs a later event', async () => {
    const sent = await compile({ kind: 'funnel', projectId: PROJECT_ID, steps: [{ event: 'A' }, { event: 'A' }] });
    expect(sent[0]?.sql).toContain('q.ts > p.t');
  });

  it('sessions: aggregates by session id, no OFFSET, chunk lookup for the page only', async () => {
    const sent = await compile(
      { kind: 'sessions', projectId: PROJECT_ID, limit: 2, cursor: 'o2' },
      ctxWith(),
      { 'sessions.list': [{ session_id: 'a' }, { session_id: 'b' }, { session_id: 'c' }, { session_id: 'd' }, { session_id: 'e' }] },
    );
    expect(sent.map((q) => q.name)).toEqual(['sessions.list', 'sessions.chunks']);
    const list = sent[0]?.sql as string;
    expect(list).toContain('GROUP BY session_id');
    expect(list).toContain('LIMIT 5');
    expect(list).not.toMatch(/OFFSET/i);
    expect(list).toContain('e.session_id IS NOT NULL');
    expect(sent[1]?.sql).toContain("session_id IN ('c', 'd')");
  });

  it('heatmap: device classes use the viewport breakpoints', async () => {
    const mobile = await compile(SPECS['heatmap click'] as PanelQuerySpec, ctxWith({ pageGroups: { pnh_1: '/products/*' } }));
    expect(mobile.find((q) => q.name === 'heatmap.points')?.sql).toContain('e.viewport_w < 768');
    const desktop = await compile(SPECS['heatmap scroll'] as PanelQuerySpec);
    expect(desktop.find((q) => q.name === 'heatmap.scroll')?.sql).toContain('(e.viewport_w IS NULL OR e.viewport_w >= 1024)');
    const tablet = await compile(SPECS['heatmap area'] as PanelQuerySpec);
    expect(tablet.find((q) => q.name === 'heatmap.elements')?.sql).toContain('(e.viewport_w >= 768 AND e.viewport_w < 1024)');
  });

  it('web: derives cookieless visits from 30-minute gaps', async () => {
    const sent = await compile({ kind: 'web', projectId: PROJECT_ID });
    const summary = sent.find((q) => q.name === 'web.summary')?.sql as string;
    expect(summary).toContain('PARTITION BY COALESCE(e.session_id, e.anon_id)');
    expect(summary).toContain('> 1800');
    expect(summary.match(/panel\.events_v1/g)).toHaveLength(1);
  });

  it('cohort filters become person subqueries, scoped like everything else', async () => {
    const sent = await compile(
      { kind: 'web', projectId: PROJECT_ID, filters: [{ source: 'cohort', cohortId: 'pnc_1' }] },
      ctxWith(WITH_COHORT),
    );
    const sql = sent[0]?.sql as string;
    expect(sql).toContain('COALESCE(i.user_id, e.distinct_id) IN (SELECT pl2.user_id FROM');
    expect(sql).toContain('NOT IN (SELECT');
    expect(sql).toContain('HAVING COUNT(*) >= 1');
  });
});
