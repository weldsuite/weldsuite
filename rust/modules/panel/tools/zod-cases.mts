/**
 * Writes rust/modules/panel/src/zod_cases.json: bodies parsed by panel-api's
 * own Zod schemas (`safeParseAsync`, what `zValidator` runs), with Zod's
 * answer, so a Rust test parses the same bodies with the generated schemas
 * (`schemas_gen.rs`) and compares issue for issue, in Zod's order.
 *
 *   pnpm --filter panel-api exec tsx ../../../rust/modules/panel/tools/zod-cases.mts
 *
 * Commit the output. Add a case when a hook or a schema changes.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const requireFrom = createRequire(path.join(repo, 'apps/workers/panel-api/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);

const query = await load('@weldsuite/app-api-client/schemas/weldpanel-query');
const collab = await load('@weldsuite/app-api-client/schemas/weldpanel-collab');
const objects = await load('@weldsuite/app-api-client/schemas/weldpanel-objects');

/** By the generated constant's name. */
const SCHEMAS = {
  PANEL_QUERY_SPEC: query.panelQuerySpecSchema,
  PANEL_COHORT_FILTER: query.panelCohortFilterSchema,
  PANEL_CUSTOM_EVENT_DEFINITION: collab.panelCustomEventDefinitionSchema,
  PANEL_COMPUTED_PROPERTY_DEFINITION: collab.panelComputedPropertyDefinitionSchema,
  UPDATE_PANEL_LEXICON: objects.updatePanelLexiconSchema,
} as const;

const CASES: Array<[string, keyof typeof SCHEMAS, unknown]> = [
  ['an unknown kind', 'PANEL_QUERY_SPEC', { kind: 'nope', projectId: 'pnp_a' }],
  [
    'a bad property key',
    'PANEL_QUERY_SPEC',
    { kind: 'web', projectId: 'pnp_a', dateRange: { preset: '7d' }, filters: [{ source: 'event', key: "a'b", operator: 'eq', value: 1 }] },
  ],
  ['a web spec, defaults filled in', 'PANEL_QUERY_SPEC', { kind: 'web', projectId: 'pnp_a', dateRange: { preset: '7d' }, workspaceId: 'ws_other' }],
  [
    'a funnel against its rules',
    'PANEL_QUERY_SPEC',
    {
      kind: 'funnel',
      projectId: 'p',
      steps: [{ event: 'a', optional: true }, { event: '$pageview' }],
      exclusions: [{ event: 'b', fromStep: 1, toStep: 3 }],
      order: 'any',
      dateRange: { from: '2026-02-01', to: '2026-01-01' },
    },
  ],
  [
    'trends against its rules',
    'PANEL_QUERY_SPEC',
    {
      kind: 'trends',
      projectId: 'p',
      series: [
        { event: 'x', math: 'sum' },
        { event: '@pnce_abc', math: 'unique_groups' },
      ],
      breakdown: { source: 'column', field: 'path' },
      breakdowns: [{ source: 'event', key: '@pncp_x', bucket: { kind: 'custom', edges: [5, 1] } }],
      formulaOnly: true,
      filters: [
        { source: 'column', field: 'country', operator: 'in', value: 'NL' },
        { source: 'person', key: '$email', operator: 'gt', value: true },
      ],
    },
  ],
  [
    'a trends spec, defaults filled in',
    'PANEL_QUERY_SPEC',
    {
      kind: 'trends',
      projectId: 'p',
      series: [{ event: '$pageview', math: 'avg', property: '$lcp' }],
      formulas: [{ expression: 'A / 2' }],
      breakdowns: [{ source: 'group', groupType: 'company', key: 'plan', bucket: { kind: 'auto' } }],
      dateRange: { from: '2026-01-01', to: '2026-01-31' },
    },
  ],
  ['a heatmap without a page', 'PANEL_QUERY_SPEC', { kind: 'heatmap', projectId: 'p', type: 'scroll', deviceClass: 'desktop' }],
  ['a heatmap pattern', 'PANEL_QUERY_SPEC', { kind: 'heatmap', projectId: 'p', type: 'click', deviceClass: 'mobile', urlPattern: 'products' }],
  ['a sessions spec', 'PANEL_QUERY_SPEC', { kind: 'sessions', projectId: 'p', cursor: null, devices: ['phone'], limit: 0 }],
  ['an impact spec', 'PANEL_QUERY_SPEC', { kind: 'impact', projectId: 'p', launchEvent: 'Launched', launchDate: '2026-1-1', metric: { event: 'x', math: 'sum' } }],
  ['a nested cohort', 'PANEL_COHORT_FILTER', { conditions: [{ type: 'performed', event: 'Signed up', withinDays: 30, filters: [{ source: 'cohort', cohortId: 'x' }] }] }],
  ['a cohort, defaults filled in', 'PANEL_COHORT_FILTER', { conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] }],
  ['a custom event of a custom event', 'PANEL_CUSTOM_EVENT_DEFINITION', { match: [{ event: '@pnce_x' }] }],
  ['a formula', 'PANEL_COMPUTED_PROPERTY_DEFINITION', { kind: 'formula', expression: '  price * quantity ' }],
  ['nothing to update', 'UPDATE_PANEL_LEXICON', { projectId: 'pnp_a', kind: 'event', name: 'x' }],
  ['a lexicon change', 'UPDATE_PANEL_LEXICON', { projectId: 'pnp_a', kind: 'property', name: 'plan', description: null }],
];

const cases = [];
for (const [name, schema, input] of CASES) {
  cases.push({ name, schema, input, output: await SCHEMAS[schema].safeParseAsync(input) });
}
writeFileSync(path.join(here, '../src/zod_cases.json'), `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases`);
