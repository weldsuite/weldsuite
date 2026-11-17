import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  applyPanelPathRules,
  createPanelAnnotationSchema,
  createPanelCommentSchema,
  createPanelComputedPropertySchema,
  createPanelCustomEventSchema,
  createPanelDashboardFromTemplateSchema,
  createPanelMetricTreeSchema,
  createPanelShareLinkSchema,
  PANEL_MAX_PATH_RULE_LENGTH,
  PANEL_MAX_PATH_RULES,
  PANEL_SHARE_TOKEN,
  panelAnnotationListQuerySchema,
  panelComputedPropertyDefinitionSchema,
  panelCustomEventMatchSchema,
  panelMetricTreeMetricSchema,
  panelMetricTreeNodeSchema,
  panelMetricTreeNodesSchema,
  panelMetricTreeProblem,
  panelPathPatternProblem,
  panelPathReplacementProblem,
  panelPathRuleInputSchema,
  panelPublicResultsSchema,
  panelShareUrl,
  panelSingleSeriesTrendsSpecSchema,
  panelTargetQuerySchema,
  setPanelPathRulesSchema,
  testPanelPathRulesSchema,
  updatePanelAnnotationSchema,
  updatePanelCommentSchema,
  updatePanelComputedPropertySchema,
  updatePanelCustomEventSchema,
  updatePanelMetricTreeSchema,
  withoutTrailingSlash,
} from './weldpanel-collab';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';
const TRENDS = { kind: 'trends', projectId, series: [{ event: '$pageview' }] };

describe('custom events', () => {
  it('matches tracked events with their own filters, filters defaulting to none', () => {
    expect(
      createPanelCustomEventSchema.parse({
        projectId,
        name: '  Converted ',
        definition: { match: [{ event: 'Signed up' }, { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/thanks' }] }] },
      }),
    ).toEqual({
      projectId,
      name: 'Converted',
      definition: {
        match: [
          { event: 'Signed up', filters: [] },
          { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/thanks' }] },
        ],
      },
    });
  });

  it('never includes another custom event', () => {
    expect(issuesOf(panelCustomEventMatchSchema, { event: '@pnce_abc' })).toContain('event: A custom event cannot include another custom event');
  });

  it('needs at least one match and at least one change on update', () => {
    expect(issuesOf(createPanelCustomEventSchema, { projectId, name: 'Empty', definition: { match: [] } })).toHaveLength(1);
    expect(issuesOf(updatePanelCustomEventSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelCustomEventSchema.parse({ description: null })).toEqual({ description: null });
  });
});

describe('computed properties', () => {
  it('reads a formula and a coalesce of event properties and columns', () => {
    expect(panelComputedPropertyDefinitionSchema.parse({ kind: 'formula', expression: ' price * quantity ' })).toEqual({
      kind: 'formula',
      expression: 'price * quantity',
    });
    const coalesce = { kind: 'coalesce', keys: [{ source: 'event', key: '$current_url' }, { source: 'column', field: 'url' }] };
    expect(panelComputedPropertyDefinitionSchema.parse(coalesce)).toEqual(coalesce);
  });

  it('needs 2 to 5 inputs for a coalesce and a known column', () => {
    expect(panelComputedPropertyDefinitionSchema.safeParse({ kind: 'coalesce', keys: [{ source: 'event', key: 'a' }] }).success).toBe(false);
    expect(
      panelComputedPropertyDefinitionSchema.safeParse({ kind: 'coalesce', keys: [{ source: 'event', key: 'a' }, { source: 'column', field: 'ip' }] })
        .success,
    ).toBe(false);
  });

  it('creates with a definition and updates any one field', () => {
    expect(
      createPanelComputedPropertySchema.safeParse({ projectId, name: 'Line total', definition: { kind: 'formula', expression: 'a * b' } }).success,
    ).toBe(true);
    expect(issuesOf(updatePanelComputedPropertySchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelComputedPropertySchema.safeParse({ name: 'Total' }).success).toBe(true);
  });
});

describe('path rule patterns', () => {
  it('accepts a regular expression the query engine can run', () => {
    expect(panelPathPatternProblem('^/users/\\d+')).toBeNull();
    expect(panelPathPatternProblem('/(?<id>[0-9]+)$')).toBeNull();
  });

  it.each([
    ['', 'Enter a pattern'],
    ['a'.repeat(PANEL_MAX_PATH_RULE_LENGTH + 1), `Use at most ${PANEL_MAX_PATH_RULE_LENGTH} characters`],
    ['/users\u0000', 'Control characters are not allowed'],
    ['/users\u007f', 'Control characters are not allowed'],
    ['/users(?=/edit)', 'Lookarounds and backreferences are not supported'],
    ['/users(?!/edit)', 'Lookarounds and backreferences are not supported'],
    ['(?<=/)users', 'Lookarounds and backreferences are not supported'],
    ['(?<!/)users', 'Lookarounds and backreferences are not supported'],
    ['/(a)\\1', 'Lookarounds and backreferences are not supported'],
    ['/(?<x>a)\\k<x>', 'Lookarounds and backreferences are not supported'],
    ['/users/(', 'Not a valid regular expression'],
    ['.*', 'The pattern must not match an empty path'],
  ])('refuses %j: %s', (pattern, problem) => {
    expect(panelPathPatternProblem(pattern)).toBe(problem);
  });
});

describe('path rule replacements', () => {
  it('accepts plain text, numbered and named groups', () => {
    expect(panelPathReplacementProblem('/users/:id')).toBeNull();
    expect(panelPathReplacementProblem('/users/$1')).toBeNull();
    expect(panelPathReplacementProblem('/users/${id}')).toBeNull();
    expect(panelPathReplacementProblem('')).toBeNull();
  });

  it.each([
    ['a'.repeat(PANEL_MAX_PATH_RULE_LENGTH + 1), `Use at most ${PANEL_MAX_PATH_RULE_LENGTH} characters`],
    ['/users\n', 'Control characters are not allowed'],
    ['/users/$&', "Use $1 or ${name} in the replacement, not $& or $` or $'"],
    ['$`/users', "Use $1 or ${name} in the replacement, not $& or $` or $'"],
    ["/users$'", "Use $1 or ${name} in the replacement, not $& or $` or $'"],
  ])('refuses %j: %s', (replacement, problem) => {
    expect(panelPathReplacementProblem(replacement)).toBe(problem);
  });
});

describe('path rule inputs', () => {
  it('reports pattern and replacement problems on their fields', () => {
    expect(panelPathRuleInputSchema.safeParse({ pattern: '^/users/\\d+', replacement: '/users/:id', description: null }).success).toBe(true);
    expect(issuesOf(panelPathRuleInputSchema, { pattern: '', replacement: '$&' })).toEqual([
      'pattern: Enter a pattern',
      "replacement: Use $1 or ${name} in the replacement, not $& or $` or $'",
    ]);
  });

  it(`holds at most ${PANEL_MAX_PATH_RULES} rules per project`, () => {
    const rule = { pattern: '^/a', replacement: '/b' };
    expect(setPanelPathRulesSchema.safeParse({ rules: Array.from({ length: PANEL_MAX_PATH_RULES }, () => rule) }).success).toBe(true);
    expect(setPanelPathRulesSchema.safeParse({ rules: Array.from({ length: PANEL_MAX_PATH_RULES + 1 }, () => rule) }).success).toBe(false);
  });

  it('tests the given rules or a project, never neither', () => {
    expect(testPanelPathRulesSchema.safeParse({ projectId, paths: ['/users/1'] }).success).toBe(true);
    expect(testPanelPathRulesSchema.safeParse({ rules: [], paths: ['/users/1'] }).success).toBe(true);
    expect(issuesOf(testPanelPathRulesSchema, { paths: ['/users/1'] })).toEqual(['rules: Send rules or a project']);
    expect(testPanelPathRulesSchema.safeParse({ projectId, paths: [] }).success).toBe(false);
  });
});

describe('applying path rules', () => {
  it('applies the rules in order, replacing every match, and says which ones changed the path', () => {
    const rules = [
      { pattern: '/\\d+', replacement: '/:id' },
      { pattern: '^/shop', replacement: '/store' },
      { pattern: '/never', replacement: '/x' },
    ];
    expect(applyPanelPathRules('/shop/12/items/34', rules)).toEqual({ cleaned: '/store/:id/items/:id', matched: [0, 1] });
  });

  it('skips a rule with a pattern or replacement it could not run', () => {
    const rules = [
      { pattern: '(?=x)', replacement: '' },
      { pattern: '/users', replacement: '$&' },
      { pattern: '/users/(\\d+)', replacement: '/people/$1' },
    ];
    expect(applyPanelPathRules('/users/7', rules)).toEqual({ cleaned: '/people/7', matched: [2] });
    expect(applyPanelPathRules('/users/7', [])).toEqual({ cleaned: '/users/7', matched: [] });
  });
});

describe('annotations', () => {
  it('creates a project-wide or report annotation at a moment', () => {
    expect(createPanelAnnotationSchema.parse({ projectId, occurredAt: '2026-11-01T09:00:00+01:00', label: ' Launch ' })).toEqual({
      projectId,
      occurredAt: '2026-11-01T09:00:00+01:00',
      label: 'Launch',
    });
    expect(createPanelAnnotationSchema.safeParse({ projectId, reportId: 'pnr_1', occurredAt: '2026-11-01', label: 'Launch' }).success).toBe(false);
  });

  it('updates at least one field', () => {
    expect(issuesOf(updatePanelAnnotationSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelAnnotationSchema.parse({ reportId: null })).toEqual({ reportId: null });
  });

  it('lists from and to a day or a moment', () => {
    expect(panelAnnotationListQuerySchema.safeParse({ projectId, from: '2026-11-01', to: '2026-11-30T23:59:59Z' }).success).toBe(true);
    expect(issuesOf(panelAnnotationListQuerySchema, { projectId, from: '1 Nov' })).toHaveLength(1);
  });
});

describe('comments', () => {
  it('posts on a report or dashboard and edits the body', () => {
    expect(createPanelCommentSchema.parse({ targetType: 'dashboard', targetId: 'pnd_1', body: ' Nice ' })).toEqual({
      targetType: 'dashboard',
      targetId: 'pnd_1',
      body: 'Nice',
    });
    expect(createPanelCommentSchema.safeParse({ targetType: 'cohort', targetId: 'pnco_1', body: 'x' }).success).toBe(false);
    expect(updatePanelCommentSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(panelTargetQuerySchema.parse({ targetType: 'report', targetId: 'pnr_1' })).toEqual({ targetType: 'report', targetId: 'pnr_1' });
  });
});

describe('dashboard templates', () => {
  it('creates a private dashboard from a built-in template by default', () => {
    expect(createPanelDashboardFromTemplateSchema.parse({ projectId, template: 'acquisition' })).toEqual({
      projectId,
      template: 'acquisition',
      visibility: 'private',
    });
    expect(createPanelDashboardFromTemplateSchema.safeParse({ projectId, template: 'acquisition', locale: 'de' }).success).toBe(false);
    expect(createPanelDashboardFromTemplateSchema.safeParse({ projectId, template: 'sales' }).success).toBe(false);
  });
});

describe('metric trees', () => {
  const root = { id: 'revenue', label: 'Revenue', parentId: null, relation: null, metric: { reportId: 'pnr_1' } };
  const child = { id: 'orders', label: 'Orders', parentId: 'revenue', relation: 'product', metric: { spec: TRENDS } };

  it('measures a saved report or a one-series trends spec', () => {
    expect(panelMetricTreeMetricSchema.safeParse({ reportId: 'pnr_1' }).success).toBe(true);
    expect(panelMetricTreeMetricSchema.safeParse({ spec: TRENDS }).success).toBe(true);
    expect(issuesOf(panelSingleSeriesTrendsSpecSchema, { ...TRENDS, series: [{ event: 'A' }, { event: 'B' }] })).toEqual([
      'series: A metric is one series',
    ]);
  });

  it('takes node ids of letters, digits, - and _', () => {
    expect(panelMetricTreeNodeSchema.safeParse(root).success).toBe(true);
    expect(issuesOf(panelMetricTreeNodeSchema, { ...root, id: 'has space' })).toEqual(['id: Use letters, digits, - and _']);
  });

  it('accepts a tree with one root and known parents', () => {
    expect(panelMetricTreeProblem([root, child, { ...child, id: 'aov', relation: 'influence' }])).toBeNull();
  });

  it.each([
    ['duplicate ids', [root, child, { ...child }], 'Two nodes have the id "orders"'],
    ['no root', [{ ...child }], 'A tree has exactly one root'],
    ['two roots', [root, { ...root, id: 'other' }], 'A tree has exactly one root'],
    ['a root with a relation', [{ ...root, relation: 'sum' }], 'The root has no relation'],
    ['an unknown parent', [root, { ...child, parentId: 'missing' }], 'Node "orders" has an unknown parent'],
    [
      'a cycle',
      [root, { ...child, id: 'a', parentId: 'b' }, { ...child, id: 'b', parentId: 'a' }],
      'The nodes form a cycle',
    ],
  ])('refuses %s', (_name, nodes, problem) => {
    expect(panelMetricTreeProblem(nodes)).toBe(problem);
    expect(issuesOf(panelMetricTreeNodesSchema, nodes)).toEqual([`: ${problem}`]);
  });

  it('creates a private tree by default and updates at least one field', () => {
    expect(createPanelMetricTreeSchema.parse({ projectId, name: 'Revenue', nodes: [root] })).toMatchObject({ visibility: 'private' });
    expect(issuesOf(updatePanelMetricTreeSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelMetricTreeSchema.safeParse({ nodes: [root, child] }).success).toBe(true);
    expect(updatePanelMetricTreeSchema.safeParse({ nodes: [] }).success).toBe(false);
  });
});

describe('share links', () => {
  it('recognises a share token', () => {
    expect(PANEL_SHARE_TOKEN.test('wpsh_abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(PANEL_SHARE_TOKEN.test('wpsh_short')).toBe(false);
  });

  it('creates a link that does not embed, keeps its dates and never expires by default', () => {
    expect(createPanelShareLinkSchema.parse({ targetType: 'report', targetId: 'pnr_1' })).toEqual({
      targetType: 'report',
      targetId: 'pnr_1',
      allowEmbed: false,
      allowDateChange: false,
    });
    expect(createPanelShareLinkSchema.safeParse({ targetType: 'report', targetId: 'pnr_1', expiresAt: 'tomorrow' }).success).toBe(false);
  });

  it('builds the public page URL without doubled slashes', () => {
    expect(panelShareUrl('https://app.weldsuite.org/', 'wpsh_x')).toBe('https://app.weldsuite.org/s/panel/wpsh_x');
    expect(panelShareUrl('https://app.weldsuite.org', 'wpsh_x')).toBe('https://app.weldsuite.org/s/panel/wpsh_x');
  });

  it('strips every trailing slash', () => {
    expect(withoutTrailingSlash('https://a.example.com///')).toBe('https://a.example.com');
    expect(withoutTrailingSlash('https://a.example.com/x')).toBe('https://a.example.com/x');
    expect(withoutTrailingSlash('///')).toBe('');
    expect(withoutTrailingSlash('')).toBe('');
  });

  it('runs a shared tile with another date preset', () => {
    expect(panelPublicResultsSchema.parse({})).toEqual({});
    expect(panelPublicResultsSchema.parse({ tileId: 'pndt_1', dateRange: { preset: '90d' } })).toEqual({ tileId: 'pndt_1', dateRange: { preset: '90d' } });
    expect(panelPublicResultsSchema.safeParse({ dateRange: { from: '2026-11-01', to: '2026-11-02' } }).success).toBe(false);
  });
});
