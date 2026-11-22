/**
 * The WeldPanel sample data answers every route the platform calls, and what it
 * answers has the shape the app-api client contract describes: wherever the
 * contract has a schema for (a part of) a response, the sample answer must
 * parse with it. Time is frozen so the answers are the same on every run.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import {
  panelComputedPropertyDefinitionSchema,
  panelCustomEventDefinitionSchema,
  panelMetricTreeNodesSchema,
  panelSingleSeriesTrendsSpecSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { panelAlertConditionSchema, panelExportDestinationSchema, panelSubscriptionScheduleSchema } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { panelInstallInfoSchema, panelProjectDtoSchema } from '@weldsuite/app-api-client/schemas/weldpanel';
import { PANEL_QUERY_KINDS, panelCohortFilterSchema, panelQuerySpecSchema, panelReportSpecSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { COMPANIES, PEOPLE, REPORT_REFS, SESSIONS } from './dataset';
import { defaultSpec, seedCohorts } from './areas/objects-specs';
import { handleSampleRequest, UNHANDLED } from './router';

// Before the sample data is imported, so what it makes at load time is dated the same.
vi.hoisted(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
});

const WEBSITE = 'pnp_sample_website';
const APP = 'pnp_sample_app';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Sends a request through the router, letting its short loading delay pass. A thrown error is rethrown. */
async function call(method: Method, path: string, body?: unknown, raw = false): Promise<unknown> {
  const settled = handleSampleRequest({ method, path, body, raw }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/** The `data` of an answer; fails when the router didn't handle the request. */
function dataOf(answer: unknown): unknown {
  expect(answer).not.toBe(UNHANDLED);
  expect(answer).toHaveProperty('data');
  return (answer as { data: unknown }).data;
}

function listOf(answer: unknown): unknown[] {
  const data = dataOf(answer);
  expect(Array.isArray(data)).toBe(true);
  expect(answer).toHaveProperty('pagination.totalCount');
  return data as unknown[];
}

/** Every item of a list answer parses with `schema`, and the list isn't empty. */
function itemsParse(schema: ZodTypeAny): (answer: unknown) => void {
  return (answer) => {
    const items = listOf(answer);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(schema.parse(item)).toBeDefined();
  };
}

/** The `data` of an answer parses with `schema`. */
function dataParses(schema: ZodTypeAny): (answer: unknown) => void {
  return (answer) => {
    expect(schema.parse(dataOf(answer))).toBeDefined();
  };
}

/** The parts of a report a contract schema covers. */
const reportShape = z.object({ spec: panelReportSpecSchema }).passthrough();
const dashboardShape = z
  .object({
    tiles: z.array(z.object({ spec: panelReportSpecSchema.nullable() }).passthrough()),
    reports: z.array(reportShape),
  })
  .passthrough();
const alertShape = z.object({ condition: panelAlertConditionSchema, spec: panelSingleSeriesTrendsSpecSchema.nullable() }).passthrough();
const subscriptionShape = z.object({ schedule: panelSubscriptionScheduleSchema }).passthrough();
const exportShape = z.object({ destination: panelExportDestinationSchema }).passthrough();
const cohortShape = z.object({ filter: panelCohortFilterSchema }).passthrough();
const customEventShape = z.object({ definition: panelCustomEventDefinitionSchema }).passthrough();
const computedPropertyShape = z.object({ definition: panelComputedPropertyDefinitionSchema }).passthrough();
const metricTreeShape = z.object({ nodes: panelMetricTreeNodesSchema }).passthrough();
const personId = PEOPLE[0]!.distinctId;
const sessionId = SESSIONS[0]!.sessionId;
const company = COMPANIES[0]!;

type ReadCase = [name: string, path: string, check?: (answer: unknown) => void];

const READS: ReadCase[] = [
  ['projects', '/panel/projects', itemsParse(panelProjectDtoSchema)],
  ['a project', `/panel/projects/${WEBSITE}`, dataParses(panelProjectDtoSchema)],
  ['install info', `/panel/projects/${APP}/install`, dataParses(panelInstallInfoSchema)],
  ['keys', `/panel/projects/${WEBSITE}/keys`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['usage', '/panel/usage', (answer) => expect(dataOf(answer)).toHaveProperty('events.used')],
  ['live visitors of the website', `/panel/live?projectId=${WEBSITE}`, (answer) => expect(dataOf(answer)).toMatchObject({ visitors: expect.any(Number), visitors30m: expect.any(Number), perMinute: expect.any(Array) })],
  ['live visitors of the app', `/panel/live?projectId=${APP}`, (answer) => expect(dataOf(answer)).toHaveProperty('sessions')],
  ['lexicon of the website', `/panel/lexicon?projectId=${WEBSITE}`, (answer) => expect(dataOf(answer)).toHaveProperty('events')],
  ['lexicon of the app', `/panel/lexicon?projectId=${APP}`, (answer) => expect(dataOf(answer)).toHaveProperty('properties')],
  ['people', '/panel/people', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['people, searched', '/panel/people?search=nl&limit=5'],
  ['people of a cohort', '/panel/people?cohortId=coh_sample_power'],
  ['people of the trial cohort', '/panel/people?cohortId=coh_sample_trials'],
  ['people of the at-risk cohort', '/panel/people?cohortId=coh_sample_at_risk'],
  ['people of the Dutch cohort', '/panel/people?cohortId=coh_sample_nl_smb'],
  ['people of another cohort', '/panel/people?cohortId=coh_other'],
  ['a person', `/panel/people/${personId}`, (answer) => expect(dataOf(answer)).toHaveProperty('person.userId', personId)],
  ['people by email', `/panel/people/by-email?email=${encodeURIComponent(PEOPLE[1]!.email)}`, (answer) => expect(dataOf(answer)).toHaveProperty('people')],
  ['a session', `/panel/sessions/${sessionId}`, (answer) => expect(dataOf(answer)).toHaveProperty('chunks')],
  ['the summary of a session', `/panel/sessions/${SESSIONS[1]!.sessionId}/summary`],
  ['heatmap page groups', `/panel/heatmaps/pages?projectId=${WEBSITE}`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['reports', `/panel/reports?projectId=${WEBSITE}`, itemsParse(reportShape)],
  ['reports of the app, by kind', `/panel/reports?projectId=${APP}&kind=trends`, itemsParse(reportShape)],
  ['my reports', `/panel/reports?projectId=${WEBSITE}&scope=mine`],
  ['shared reports', `/panel/reports?projectId=${WEBSITE}&scope=shared`],
  ['a report', '/panel/reports/rep_sample_signups', dataParses(reportShape)],
  ['dashboards', `/panel/dashboards?projectId=${WEBSITE}`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['my dashboards', `/panel/dashboards?projectId=${APP}&scope=mine`],
  ['shared dashboards', `/panel/dashboards?projectId=${APP}&scope=shared`],
  ['dashboard templates', '/panel/dashboards/templates', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['dashboard templates in Dutch', '/panel/dashboards/templates?locale=nl'],
  ['a dashboard', '/panel/dashboards/dash_sample_growth', dataParses(dashboardShape)],
  ['another dashboard', '/panel/dashboards/dash_sample_product', dataParses(dashboardShape)],
  ['cohorts', `/panel/cohorts?projectId=${WEBSITE}`, itemsParse(cohortShape)],
  ['a cohort', '/panel/cohorts/coh_sample_power', dataParses(cohortShape)],
  ['group types', `/panel/group-types?projectId=${WEBSITE}`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['companies', '/panel/groups?type=company', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['workspaces, searched', '/panel/groups?type=workspace&search=a&limit=3'],
  ['teams', '/panel/groups?type=team'],
  ['groups of another type', '/panel/groups?type=region'],
  ['a company', `/panel/groups/company/${company.domain}?days=30`, (answer) => expect(dataOf(answer)).toHaveProperty('group.groupKey', company.domain)],
  ['a workspace', `/panel/groups/workspace/ws_${company.key}01`],
  ['a team', '/panel/groups/team/team_sales'],
  ['custom events', `/panel/custom-events?projectId=${WEBSITE}`, itemsParse(customEventShape)],
  ['a custom event', '/panel/custom-events/pnce_sample_lead', dataParses(customEventShape)],
  ['computed properties', `/panel/computed-properties?projectId=${WEBSITE}`, itemsParse(computedPropertyShape)],
  ['a computed property', '/panel/computed-properties/pncp_sample_net_revenue', dataParses(computedPropertyShape)],
  ['path rules of the website', `/panel/path-rules?projectId=${WEBSITE}`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['path rules of the app', `/panel/path-rules?projectId=${APP}`],
  ['path rules without a project', '/panel/path-rules'],
  ['annotations', `/panel/annotations?projectId=${WEBSITE}`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['annotations of a report', `/panel/annotations?projectId=${WEBSITE}&reportId=rep_sample_signups`],
  ['annotations in a window of days', `/panel/annotations?projectId=${WEBSITE}&from=2026-11-05&to=2026-11-19`],
  ['annotations in a window of instants', `/panel/annotations?projectId=${APP}&from=2026-10-01T00:00:00Z&to=2026-11-01T12:00:00Z`],
  ['an annotation', '/panel/annotations/pnan_sample_1'],
  ['comments of a report', '/panel/comments?targetType=report&targetId=rep_sample_signups', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['comments of a dashboard', '/panel/comments?targetType=dashboard&targetId=dash_sample_growth'],
  ['report versions', '/panel/reports/rep_sample_signups/versions', itemsParse(z.object({ version: z.number() }).passthrough())],
  ['a report version', '/panel/reports/rep_sample_signups/versions/1', dataParses(reportShape)],
  ['metric trees', `/panel/metric-trees?projectId=${WEBSITE}`, itemsParse(metricTreeShape)],
  ['my metric trees', `/panel/metric-trees?projectId=${APP}&scope=mine`],
  ['shared metric trees', `/panel/metric-trees?projectId=${APP}&scope=shared`],
  ['a metric tree', '/panel/metric-trees/pnmt_sample_customers', dataParses(metricTreeShape)],
  ['share links', '/panel/share-links?targetType=report&targetId=rep_sample_signups', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['alerts', '/panel/alerts', itemsParse(alertShape)],
  ['my alerts of a project', `/panel/alerts?projectId=${WEBSITE}&scope=mine`],
  ['an alert', '/panel/alerts/pnal_sample_signups', dataParses(alertShape)],
  ['the history of an alert', '/panel/alerts/pnal_sample_signups/events', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['the history of an alert, limited', '/panel/alerts/pnal_sample_installs/events?limit=1'],
  ['subscriptions', '/panel/subscriptions', itemsParse(subscriptionShape)],
  ['subscriptions of a report', `/panel/subscriptions?projectId=${WEBSITE}&scope=mine&targetType=report&targetId=rep_sample_signups`],
  ['subscriptions of the app dashboards', `/panel/subscriptions?projectId=${APP}&targetType=dashboard`],
  ['a subscription', '/panel/subscriptions/pnsb_sample_growth', dataParses(subscriptionShape)],
  ['exports', `/panel/exports?projectId=${WEBSITE}`, itemsParse(exportShape)],
  ['an export', '/panel/exports/pnex_sample_r2', dataParses(exportShape)],
  ['the runs of an export', '/panel/exports/pnex_sample_warehouse/runs', (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
  ['the runs of an hourly export, limited', '/panel/exports/pnex_sample_r2/runs?limit=3'],
  ['the runs of a failing export', '/panel/exports/pnex_sample_minio/runs'],
  ['collector domains', `/panel/projects/${WEBSITE}/domains`, (answer) => expect(listOf(answer).length).toBeGreaterThan(0)],
];

describe('WeldPanel sample data: reads', () => {
  it.each(READS)('answers GET %s', async (_name, path, check) => {
    const answer = await call('GET', path);
    expect(answer).not.toBe(UNHANDLED);
    check?.(answer);
  });

  it('answers a session chunk as raw JSON the player can read', async () => {
    const response = await call('GET', `/panel/sessions/${sessionId}/chunks/0`, undefined, true);
    expect(response).toBeInstanceOf(Response);
    const events = (await (response as Response).json()) as unknown[];
    expect(events.length).toBeGreaterThan(1);
  });

  it('answers a missing chunk with a 404 response', async () => {
    const response = await call('GET', `/panel/sessions/${sessionId}/chunks/99`, undefined, true);
    expect((response as Response).status).toBe(404);
  });

  it.each(['home', 'pricing', 'features', 'signup', 'blog', 'app_home', 'app_tickets'])('answers the heatmap snapshot of the %s page group', async (group) => {
    const response = (await call('GET', `/panel/heatmaps/pages/pnhp_sample_${group}/snapshot`, undefined, true)) as Response;
    const event = (await response.json()) as { type: number; data: { node: { childNodes: unknown[] } } };
    expect(event.type).toBe(2);
    expect(event.data.node.childNodes.length).toBeGreaterThan(0);
  });

  it('gives every recorded session a replay with a first page and activity', async () => {
    for (const session of SESSIONS) {
      const detail = dataOf(await call('GET', `/panel/sessions/${session.sessionId}`)) as { chunks: unknown[]; events: unknown[] };
      expect(detail.chunks).toHaveLength(session.pages.length);
      expect(detail.events.length).toBeGreaterThan(0);
    }
  });

  it('answers a person that does not exist with a 404 error', async () => {
    await expect(call('GET', '/panel/people/nobody')).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['a project', '/panel/projects/pnp_nope'],
    ['a session', '/panel/sessions/ses_nope'],
    ['a report', '/panel/reports/rep_nope'],
    ['a dashboard', '/panel/dashboards/dash_nope'],
    ['a cohort', '/panel/cohorts/coh_nope'],
    ['an alert', '/panel/alerts/pnal_nope'],
    ['a subscription', '/panel/subscriptions/pnsb_nope'],
    ['an export', '/panel/exports/pnex_nope'],
    ['a custom event', '/panel/custom-events/pnce_nope'],
  ])('rejects the read of %s that does not exist', async (_name, path) => {
    await expect(call('GET', path)).rejects.toBeInstanceOf(Error);
  });

  it.each([
    ['an unknown area', '/panel/unknown'],
    ['no area', '/panel'],
    ['a deeper path than any route', '/panel/reports/rep_sample_signups/other'],
    ['an unknown action', '/panel/alerts/pnal_sample_signups/other'],
  ])('does not handle %s', async (_name, path) => {
    const answer = await call('GET', path).catch((error: unknown) => error);
    expect(answer === UNHANDLED || answer instanceof Error).toBe(true);
  });
});

describe('WeldPanel sample data: queries', () => {
  const cases = [WEBSITE, APP].flatMap((projectId) =>
    PANEL_QUERY_KINDS.map((kind) => ({ projectId, kind, spec: specOf(kind, projectId) })),
  );

  it.each(cases)('answers a $kind query of $projectId with a valid spec and a result of that kind', async ({ kind, spec }) => {
    expect(panelQuerySpecSchema.safeParse(spec).success).toBe(true);
    const data = dataOf(await call('POST', '/panel/query', spec)) as { kind: string; result: unknown; dataAsOf: string; cached: boolean };
    expect(data.kind).toBe(kind);
    expect(data.result).toBeTypeOf('object');
    expect(data.cached).toBe(false);
  });

  it.each([
    ['a longer period compared with the one before, by week', { compare: true, interval: 'week' }],
    ['a week by hour', { dateRange: { preset: '7d' }, interval: 'hour' }],
    ['three months by month', { dateRange: { preset: '90d' }, interval: 'month' }],
  ])('answers a trends query over %s', async (_name, changes) => {
    const spec = { ...specOf('trends', WEBSITE), ...changes };
    expect(panelQuerySpecSchema.safeParse(spec).success).toBe(true);
    const data = dataOf(await call('POST', '/panel/query', spec)) as { result: { series: unknown[] } };
    expect(data.result.series.length).toBeGreaterThan(0);
  });

  it.each([
    ['hours', { unit: 'hour', value: 6 }],
    ['minutes', { unit: 'minute', value: 30 }],
    ['days', { unit: 'day', value: 3 }],
  ])('answers a funnel with a window in %s', async (_name, window) => {
    const spec = { ...specOf('funnel', WEBSITE), window };
    expect(panelQuerySpecSchema.safeParse(spec).success).toBe(true);
    const data = dataOf(await call('POST', '/panel/query', spec)) as { result: { steps: unknown[] } };
    expect(data.result.steps.length).toBeGreaterThan(1);
  });

  it('filters recordings by every field a recordings search has', async () => {
    const base = specOf('sessions', WEBSITE);
    const searches = [
      { sessionIds: SESSIONS.slice(0, 3).map((s) => s.sessionId) },
      { distinctId: personId },
      { minDurationSeconds: 60, maxDurationSeconds: 600 },
      { pagesVisited: ['/pricing'] },
      { entryPage: '/', exitPage: '/signup' },
      { countries: ['NL'], devices: ['desktop'], browsers: ['Chrome'] },
      { hasErrors: true },
      { favoritesOnly: true },
      { frustration: ['rage'] },
      { sort: 'duration_desc' },
      { sort: 'pages_desc' },
      { sort: 'frustration_desc' },
      { sort: 'errors_desc', limit: 5, cursor: '5' },
    ];
    for (const search of searches) {
      const spec = { ...base, ...search };
      expect(panelQuerySpecSchema.safeParse(spec).success).toBe(true);
      const data = dataOf(await call('POST', '/panel/query', spec)) as { result: { sessions: unknown[]; hasMore: boolean } };
      expect(Array.isArray(data.result.sessions)).toBe(true);
    }
  });

  it.each([WEBSITE, APP])('explains a change in a trends report of %s', async (projectId) => {
    const spec = specOf('trends', projectId);
    const explained = dataOf(await call('POST', '/panel/insights/explain', { projectId, spec, narrate: true })) as { dimensions: unknown[]; narrative: { text: string } };
    expect(explained.dimensions.length).toBeGreaterThan(0);
    expect(explained.narrative.text.length).toBeGreaterThan(20);
  });

  it('explains one bucket of a trends report, by day and by hour', async () => {
    const spec = specOf('trends', WEBSITE);
    for (const [bucket, interval] of [['2026-11-10', 'day'], ['2026-11-10T09', 'hour'], ['2026-11-01', 'week'], ['2026-10-01', 'month']] as const) {
      const explained = dataOf(await call('POST', '/panel/insights/explain', { projectId: WEBSITE, spec: { ...spec, interval }, bucket, properties: [{ source: 'person', key: 'plan' }, { source: 'event', key: 'source' }] })) as { dimensions: unknown[] };
      expect(explained.dimensions.length).toBeGreaterThan(0);
    }
  });

  it('values a metric tree that is not saved yet, and the saved ones', async () => {
    const spec = specOf('trends', WEBSITE);
    const preview = dataOf(await call('POST', '/panel/metric-tree-values', { projectId: WEBSITE, nodes: [{ id: 'root', label: 'x', parentId: null, relation: null, metric: { spec } }] })) as { nodes: Array<{ id: string }> };
    expect(preview.nodes.map((n) => n.id)).toEqual(['root']);
    for (const id of ['pnmt_sample_customers', 'pnmt_sample_active', 'pnmt_sample_leads', 'pnmt_sample_revenue']) {
      const saved = dataOf(await call('POST', `/panel/metric-tree-values/${id}`, {})) as { nodes: unknown[] };
      expect(saved.nodes.length).toBeGreaterThan(2);
    }
    expect(dataOf(await call('POST', '/panel/metric-tree-values/pnmt_unknown'))).toHaveProperty('nodes');
  });

  it.each([
    ['a query of an unknown kind', '/panel/query', { kind: 'nope' }],
    ['a query without a body', '/panel/query', undefined],
    ['an explain without a spec', '/panel/insights/explain', {}],
    ['a preview without nodes', '/panel/metric-tree-values', {}],
  ])('does not handle %s', async (_name, path, body) => {
    expect(await call('POST', path, body)).toBe(UNHANDLED);
  });
});

/** A valid query spec of `kind` (the saved-report ones come from the sample reports). */
function specOf(kind: (typeof PANEL_QUERY_KINDS)[number], projectId: string): Record<string, unknown> {
  const dateRange = { preset: '30d' };
  const timezone = 'Europe/Amsterdam';
  if (kind === 'sessions') return { kind, projectId, dateRange, timezone };
  if (kind === 'heatmap') return { kind, projectId, dateRange, timezone, type: 'click', deviceClass: 'desktop', urlPattern: '/' };
  if (kind === 'funnel_correlation') return { ...(defaultSpec('funnel', projectId) as Record<string, unknown>), kind, stepIndex: 1, mode: 'dropoff' };
  return { ...(defaultSpec(kind, projectId) as Record<string, unknown>) };
}

describe('WeldPanel sample data: changes', () => {
  const create = async (path: string, body: unknown): Promise<{ id: string }> => dataOf(await call('POST', path, body)) as { id: string };

  it('creates, changes, rotates and deletes a project and its keys', async () => {
    const project = (await create('/panel/projects', { name: 'Test', kind: 'website', allowedDomains: ['example.com'] })) as unknown as { id: string; token: string };
    const originalToken = project.token;
    expect(panelProjectDtoSchema.parse(dataOf(await call('GET', `/panel/projects/${project.id}`)))).toMatchObject({ name: 'Test' });
    const install = dataOf(await call('GET', `/panel/projects/${project.id}/install`)) as { status: string };
    expect(install.status).toBe('waiting');
    expect(dataOf(await call('PATCH', `/panel/projects/${project.id}`, { name: 'Renamed' }))).toMatchObject({ name: 'Renamed' });
    expect(dataOf(await call('PATCH', `/panel/projects/${project.id}/settings`, { status: 'paused', settings: { autocapture: false } }))).toMatchObject({ status: 'paused', settings: { autocapture: false } });
    const rotated = dataOf(await call('POST', `/panel/projects/${project.id}/rotate-token`)) as { token: string };
    expect(rotated.token).not.toBe(originalToken);

    const key = (await create(`/panel/projects/${project.id}/keys`, { name: 'CI' })) as unknown as { id: string; key: string; prefix: string };
    expect(key.key.startsWith(key.prefix)).toBe(true);
    expect(listOf(await call('GET', `/panel/projects/${project.id}/keys`))).toHaveLength(1);
    expect(await call('DELETE', `/panel/projects/${project.id}/keys/${key.id}`)).toBeUndefined();
    expect(await call('DELETE', `/panel/projects/${project.id}`)).toBeUndefined();
    await expect(call('GET', `/panel/projects/${project.id}`)).rejects.toMatchObject({ status: 404 });
    await expect(call('POST', '/panel/projects', { name: '' })).rejects.toMatchObject({ status: 400 });
  });

  it('keeps a description in the lexicon', async () => {
    const entry = dataOf(await call('PATCH', '/panel/lexicon', { projectId: WEBSITE, kind: 'event', name: 'signup_completed', description: 'Created an account', hidden: true, verified: true }));
    expect(entry).toMatchObject({ description: 'Created an account', hidden: true, verified: true });
    const added = dataOf(await call('PATCH', '/panel/lexicon', { projectId: WEBSITE, kind: 'property', name: 'brand_new_property', description: 'x' }));
    expect(added).toMatchObject({ name: 'brand_new_property', seen: false });
    const lexicon = dataOf(await call('GET', `/panel/lexicon?projectId=${WEBSITE}`)) as { events: Array<{ name: string; description: string | null }> };
    expect(lexicon.events.find((e) => e.name === 'signup_completed')?.description).toBe('Created an account');
  });

  it('erases a person and their recordings', async () => {
    const person = PEOPLE[3]!;
    expect(dataOf(await call('DELETE', `/panel/people/${person.distinctId}`))).toMatchObject({ userId: person.distinctId });
    await expect(call('GET', `/panel/people/${person.distinctId}`)).rejects.toMatchObject({ status: 404 });
    expect(dataOf(await call('DELETE', '/panel/people/nobody'))).toMatchObject({ userId: null, erasedIdCount: 0 });
  });

  it('favourites a recording, summarises it and summarises sets of recordings', async () => {
    const id = SESSIONS[2]!.sessionId;
    expect(dataOf(await call('PUT', `/panel/sessions/${id}/favorite`, { projectId: WEBSITE, note: 'Nice' }))).toMatchObject({ note: 'Nice' });
    expect(await call('DELETE', `/panel/sessions/${id}/favorite`)).toBeUndefined();
    const first = dataOf(await call('POST', `/panel/sessions/${id}/summary`, { projectId: WEBSITE })) as { cached: boolean };
    const again = dataOf(await call('POST', `/panel/sessions/${id}/summary`, { projectId: WEBSITE })) as { cached: boolean };
    const regenerated = dataOf(await call('POST', `/panel/sessions/${id}/summary`, { projectId: WEBSITE, regenerate: true })) as { cached: boolean };
    expect([first.cached, again.cached, regenerated.cached]).toEqual([false, true, false]);
    expect(dataOf(await call('GET', `/panel/sessions/${id}/summary`))).not.toBeNull();

    const sessions = { kind: 'sessions', projectId: WEBSITE, dateRange: { preset: '30d' }, timezone: 'Europe/Amsterdam' };
    const named = dataOf(await call('POST', '/panel/insights/summarise', { projectId: WEBSITE, source: { type: 'sessions', spec: { ...sessions, sessionIds: SESSIONS.slice(0, 6).map((s) => s.sessionId) } }, limit: 10 })) as { summary: { sessionsRead: number } };
    expect(named.summary.sessionsRead).toBe(6);
    const all = dataOf(await call('POST', '/panel/insights/summarise', { projectId: WEBSITE, source: { type: 'sessions', spec: sessions }, limit: 9 })) as { summary: { sessionsRead: number } };
    expect(all.summary.sessionsRead).toBe(9);
    const dropped = dataOf(await call('POST', '/panel/insights/summarise', { projectId: WEBSITE, source: { type: 'funnel_drop_off', spec: specOf('funnel', WEBSITE), stepIndex: 1 }, limit: 7 })) as { summary: { overview: string } };
    expect(dropped.summary.overview).toContain('dropped off');
  });

  it('manages heatmap page groups', async () => {
    const page = await create('/panel/heatmaps/pages', { projectId: WEBSITE, name: 'Docs', urlPattern: '/docs/*' });
    const wild = await create('/panel/heatmaps/pages', { projectId: WEBSITE, name: 'Wild', urlPattern: '/some/**//' });
    expect(dataOf(await call('PATCH', `/panel/heatmaps/pages/${page.id}`, { name: 'Documentation' }))).toMatchObject({ name: 'Documentation' });
    for (const id of [page.id, wild.id]) {
      const snapshot = (await call('GET', `/panel/heatmaps/pages/${id}/snapshot`, undefined, true)) as Response;
      expect(snapshot.status).toBe(200);
    }
    expect(await call('DELETE', `/panel/heatmaps/pages/${page.id}`)).toBeUndefined();
    await expect(call('PATCH', `/panel/heatmaps/pages/${page.id}`, { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('creates, edits and deletes a report, and takes its tiles off dashboards', async () => {
    const report = await create('/panel/reports', { projectId: WEBSITE, name: 'Funnel', description: 'd', spec: defaultSpec('funnel', WEBSITE), visibility: 'private' });
    expect(dataOf(await call('PATCH', `/panel/reports/${report.id}`, { name: 'Renamed', description: null, visibility: 'workspace', spec: defaultSpec('retention', WEBSITE) }))).toMatchObject({ name: 'Renamed', kind: 'retention' });
    expect(reportShape.parse(dataOf(await call('GET', `/panel/reports/${report.id}`)))).toBeDefined();
    const dashboard = await create('/panel/dashboards', { projectId: WEBSITE, name: 'Tmp', visibility: 'workspace' });
    await call('POST', `/panel/dashboards/${dashboard.id}/tiles`, { reportId: report.id, layout: { x: 0, y: 0, w: 6, h: 3 } });
    expect(await call('DELETE', `/panel/reports/${report.id}`)).toBeUndefined();
    expect((dataOf(await call('GET', `/panel/dashboards/${dashboard.id}`)) as { tiles: unknown[] }).tiles).toHaveLength(0);
    await expect(call('GET', `/panel/reports/${report.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it('creates a dashboard, lays out and edits its tiles and deletes it', async () => {
    const dashboard = await create('/panel/dashboards', { projectId: WEBSITE, name: 'Mine', visibility: 'workspace' });
    expect(dataOf(await call('PATCH', `/panel/dashboards/${dashboard.id}`, { name: 'Better', description: 'x', visibility: 'private', filters: { dateRange: { preset: '7d' }, filters: [] } }))).toMatchObject({ name: 'Better', visibility: 'private' });
    const text = (await create(`/panel/dashboards/${dashboard.id}/tiles`, { kind: 'text', text: 'Hello', layout: { x: 0, y: 0, w: 6, h: 2 } })) as unknown as { id: string; kind: string };
    const withReport = await create(`/panel/dashboards/${dashboard.id}/tiles`, { reportId: 'rep_sample_signups', layout: { x: 6, y: 0, w: 6, h: 3 } });
    expect(text.kind).toBe('text');
    expect(dataOf(await call('PATCH', `/panel/dashboards/${dashboard.id}/tiles/${text.id}`, { text: 'Changed', layout: { x: 1, y: 1, w: 4, h: 2 } }))).toMatchObject({ text: 'Changed' });
    const laidOut = dataOf(await call('PUT', `/panel/dashboards/${dashboard.id}/layout`, { tiles: [{ id: withReport.id, layout: { x: 3, y: 3, w: 3, h: 3 } }, { id: 'unknown', layout: { x: 0, y: 0, w: 1, h: 1 } }] })) as { tiles: unknown[] };
    expect(laidOut.tiles).toHaveLength(2);
    expect(await call('DELETE', `/panel/dashboards/${dashboard.id}/tiles/${text.id}`)).toBeUndefined();
    await expect(call('DELETE', `/panel/dashboards/${dashboard.id}/tiles/unknown`)).rejects.toMatchObject({ status: 404 });
    expect(await call('DELETE', `/panel/dashboards/${dashboard.id}`)).toBeUndefined();
    await expect(call('PUT', `/panel/dashboards/${dashboard.id}/layout`, { tiles: [] })).rejects.toMatchObject({ status: 404 });
  });

  it.each(['website-overview', 'acquisition', 'product-health', 'performance', 'engagement'])('makes a dashboard from the %s template in English and Dutch', async (template) => {
    for (const body of [{ projectId: WEBSITE, template, visibility: 'private' }, { projectId: APP, template, locale: 'nl', name: 'Eigen naam', visibility: 'workspace' }]) {
      const made = dataOf(await call('POST', '/panel/dashboards/from-template', body)) as { template: string; tiles: unknown[]; reports: unknown[] };
      expect(made.template).toBe(template);
      expect(made.tiles.length).toBeGreaterThan(0);
      expect(dashboardShape.parse(made)).toBeDefined();
    }
  });

  it('rejects a dashboard template that does not exist', async () => {
    await expect(call('POST', '/panel/dashboards/from-template', { projectId: WEBSITE, template: 'unknown', visibility: 'private' })).rejects.toMatchObject({ status: 400 });
  });

  it('creates, edits and deletes a cohort', async () => {
    const [power, trials] = seedCohorts();
    const cohort = await create('/panel/cohorts', { projectId: APP, name: 'Mine', filter: power!.filter });
    expect(listOf(await call('GET', `/panel/cohorts?projectId=${APP}`)).length).toBeGreaterThan(4);
    expect(dataOf(await call('PATCH', `/panel/cohorts/${cohort.id}`, { name: 'Theirs', description: 'x', filter: trials!.filter }))).toMatchObject({ name: 'Theirs' });
    expect(await call('DELETE', `/panel/cohorts/${cohort.id}`)).toBeUndefined();
    await expect(call('PATCH', `/panel/cohorts/${cohort.id}`, { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('adds, renames and removes group types, and forgets a deleted group', async () => {
    const team = dataOf(await call('POST', '/panel/group-types', { projectId: WEBSITE, groupType: 'team', nameSingular: 'Team', namePlural: 'Teams' })) as { id: string; configured: boolean };
    expect(team.configured).toBe(true);
    await expect(call('POST', '/panel/group-types', { projectId: WEBSITE, groupType: 'team', nameSingular: 'Team', namePlural: 'Teams' })).rejects.toMatchObject({ status: 409 });
    const region = dataOf(await call('POST', '/panel/group-types', { projectId: WEBSITE, groupType: 'region', nameSingular: 'Region', namePlural: 'Regions', crmMatchProperty: null })) as { id: string };
    expect(dataOf(await call('PATCH', `/panel/group-types/${region.id}`, { nameSingular: 'Area', namePlural: 'Areas', crmMatchProperty: 'name' }))).toMatchObject({ nameSingular: 'Area' });
    expect(await call('DELETE', `/panel/group-types/${region.id}`)).toBeUndefined();
    await expect(call('PATCH', '/panel/group-types/unknown', { nameSingular: 'x' })).rejects.toMatchObject({ status: 404 });

    const domain = COMPANIES[1]!.domain;
    expect(await call('DELETE', `/panel/groups/company/${domain}`)).toBeUndefined();
    const keys = listOf(await call('GET', '/panel/groups?type=company')).map((g) => (g as { groupKey: string }).groupKey);
    expect(keys).not.toContain(domain);
  });

  it('pages through a long list with a cursor', async () => {
    const first = (await call('GET', '/panel/people?limit=5')) as { data: unknown[]; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data).toHaveLength(5);
    expect(first.pagination.hasMore).toBe(true);
    const second = (await call('GET', `/panel/people?limit=5&cursor=${first.pagination.cursor}`)) as { data: unknown[] };
    expect(second.data).toHaveLength(5);
    expect(second.data).not.toEqual(first.data);
  });
});

describe('WeldPanel sample data: definitions and collaboration', () => {
  const create = async (path: string, body: unknown): Promise<{ id: string }> => dataOf(await call('POST', path, body)) as { id: string };
  const definition = { match: [{ event: 'signup_started' }, { event: 'signup_completed', filters: [] }] };

  it('creates, edits and deletes custom events', async () => {
    const event = await create('/panel/custom-events', { projectId: WEBSITE, name: 'Signed up', description: 'd', definition });
    expect(event.id.startsWith('pnce_')).toBe(true);
    expect(customEventShape.parse(dataOf(await call('GET', `/panel/custom-events/${event.id}`)))).toMatchObject({ ref: `@${event.id}` });
    expect(dataOf(await call('PATCH', `/panel/custom-events/${event.id}`, { name: 'Renamed', description: null, definition }))).toMatchObject({ name: 'Renamed', description: null });
    expect(dataOf(await call('PATCH', `/panel/custom-events/${event.id}`, { description: 'back' }))).toMatchObject({ name: 'Renamed', description: 'back' });
    expect(await call('DELETE', `/panel/custom-events/${event.id}`)).toBeUndefined();
    await expect(call('GET', `/panel/custom-events/${event.id}`)).rejects.toBeInstanceOf(Error);
    expect(await call('PUT', '/panel/custom-events', {})).toBe(UNHANDLED);
  });

  it('creates, edits and deletes computed properties', async () => {
    const property = await create('/panel/computed-properties', { projectId: WEBSITE, name: 'Plan', description: 'd', definition: { source: 'property', property: 'plan', transform: 'lowercase' } });
    expect(dataOf(await call('PATCH', `/panel/computed-properties/${property.id}`, { name: 'Plan name', definition: { source: 'property', property: 'plan', transform: 'uppercase' } }))).toMatchObject({ name: 'Plan name' });
    expect(dataOf(await call('PATCH', `/panel/computed-properties/${property.id}`, { description: null }))).toMatchObject({ description: null });
    expect(await call('DELETE', `/panel/computed-properties/${property.id}`)).toBeUndefined();
  });

  it('tests and replaces path rules', async () => {
    const tested = dataOf(await call('POST', '/panel/path-rules/test', { projectId: WEBSITE, paths: ['/blog/my-post', '/orders/9001'] })) as { results: Array<{ path: string; cleaned: string; matched: boolean }> };
    expect(tested.results[0]).toMatchObject({ path: '/blog/my-post', cleaned: '/blog/:slug', matched: [1] });
    const own = dataOf(await call('POST', '/panel/path-rules/test', { paths: ['/users/42'], rules: [{ pattern: '^/users/[0-9]+$', replacement: '/users/:id' }] })) as { results: Array<{ cleaned: string }> };
    expect(own.results[0]!.cleaned).toBe('/users/:id');
    expect(dataOf(await call('POST', '/panel/path-rules/test', {}))).toEqual({ results: [] });
    const saved = listOf(await call('PUT', `/panel/path-rules?projectId=${APP}`, { rules: [{ pattern: '^/a/.+', replacement: '/a/:id', description: 'x' }, { pattern: '^/b$', replacement: '/c' }] }));
    expect(saved).toHaveLength(2);
    expect(listOf(await call('GET', `/panel/path-rules?projectId=${APP}`))).toHaveLength(2);
    expect(listOf(await call('PUT', `/panel/path-rules?projectId=${APP}`, {}))).toHaveLength(0);
    expect(await call('POST', '/panel/path-rules', {})).toBe(UNHANDLED);
  });

  it('creates, edits and deletes annotations', async () => {
    const annotation = await create('/panel/annotations', { projectId: WEBSITE, reportId: 'rep_sample_signups', occurredAt: '2026-11-10T10:00:00Z', label: 'Release', description: 'd' });
    await create('/panel/annotations', { projectId: WEBSITE, occurredAt: '2026-11-11T10:00:00Z', label: 'Newsletter' });
    const inWindow = listOf(await call('GET', `/panel/annotations?projectId=${WEBSITE}&reportId=rep_sample_signups&from=2026-11-10&to=2026-11-10`));
    expect(inWindow.map((a) => (a as { id: string }).id)).toContain(annotation.id);
    expect(dataOf(await call('PATCH', `/panel/annotations/${annotation.id}`, { reportId: null, label: 'Moved', description: null, occurredAt: '2026-11-01T00:00:00Z' }))).toMatchObject({ reportId: null, label: 'Moved' });
    expect(dataOf(await call('PATCH', `/panel/annotations/pnan_sample_2`, {}))).toMatchObject({ id: 'pnan_sample_2' });
    expect(await call('DELETE', `/panel/annotations/${annotation.id}`)).toBeUndefined();
  });

  it('creates, edits and deletes comments', async () => {
    const comment = await create('/panel/comments', { targetType: 'dashboard', targetId: 'dash_sample_growth', body: 'Hello' });
    const orphan = dataOf(await call('POST', '/panel/comments', { targetType: 'dashboard', targetId: 'dash_unknown', body: 'x' })) as { projectId: string };
    expect(orphan.projectId).toBe(WEBSITE);
    expect(dataOf(await call('PATCH', `/panel/comments/${comment.id}`, { body: 'Edited' }))).toMatchObject({ body: 'Edited', edited: true });
    expect(await call('DELETE', `/panel/comments/${comment.id}`)).toBeUndefined();
    expect(await call('GET', `/panel/comments/${comment.id}`).catch((error: unknown) => error)).toBeInstanceOf(Error);
  });

  it.each(REPORT_REFS.map((r) => r.id))('gives every version of %s a spec the contract accepts', async (reportId) => {
    const versions = listOf(await call('GET', `/panel/reports/${reportId}/versions`)) as Array<{ version: number }>;
    for (const { version } of versions) {
      expect(reportShape.parse(dataOf(await call('GET', `/panel/reports/${reportId}/versions/${version}`)))).toBeDefined();
    }
  });

  it.each(['rep_sample_signups', 'rep_sample_trial_funnel', 'rep_sample_retention', 'rep_sample_vitals'])('restores an old version of %s as the newest', async (reportId) => {
    const before = listOf(await call('GET', `/panel/reports/${reportId}/versions`)) as Array<{ version: number }>;
    const restored = dataOf(await call('POST', `/panel/reports/${reportId}/versions/2/restore`)) as { id: string };
    expect(restored.id).toBe(reportId);
    expect(reportShape.parse(restored)).toBeDefined();
    const after = listOf(await call('GET', `/panel/reports/${reportId}/versions`)) as Array<{ version: number }>;
    expect(after).toHaveLength(before.length + 1);
    await expect(call('GET', `/panel/reports/${reportId}/versions/99`)).rejects.toBeInstanceOf(Error);
    await expect(call('POST', `/panel/reports/${reportId}/versions/99/restore`)).rejects.toBeInstanceOf(Error);
  });

  it('creates, edits and deletes metric trees', async () => {
    const node = { id: 'root', label: 'Reports', parentId: null, relation: null, metric: { reportId: 'rep_sample_signups' } };
    const tree = await create('/panel/metric-trees', { projectId: WEBSITE, name: 'Tree', nodes: [node] });
    await create('/panel/metric-trees', { projectId: WEBSITE, name: 'Shared', description: 'd', visibility: 'workspace', nodes: [node] });
    expect(dataOf(await call('PATCH', `/panel/metric-trees/${tree.id}`, { name: 'Better', description: null, visibility: 'workspace', nodes: [node] }))).toMatchObject({ name: 'Better' });
    expect(dataOf(await call('PATCH', `/panel/metric-trees/${tree.id}`, {}))).toMatchObject({ name: 'Better' });
    expect(listOf(await call('GET', `/panel/metric-trees?projectId=${APP}&scope=shared`)).length).toBeGreaterThan(0);
    expect(await call('DELETE', `/panel/metric-trees/${tree.id}`)).toBeUndefined();
  });

  it('creates share links, hides their token in lists and revokes them', async () => {
    const link = dataOf(await call('POST', '/panel/share-links', { targetType: 'report', targetId: 'rep_sample_signups', allowEmbed: true, allowDateChange: true, expiresAt: '2027-01-01T00:00:00Z' })) as { id: string; token: string; url: string };
    expect(link.token.startsWith('wpsh_')).toBe(true);
    expect(link.url).toContain(link.token);
    const plain = dataOf(await call('POST', '/panel/share-links', { targetType: 'dashboard', targetId: 'dash_sample_product' })) as { projectId: string };
    expect(plain.projectId).toBe(APP);
    const listed = listOf(await call('GET', '/panel/share-links?targetType=report&targetId=rep_sample_signups')) as Array<{ id: string; token?: string; revokedAt: string | null }>;
    expect(listed.every((l) => l.token === undefined)).toBe(true);
    expect(await call('DELETE', `/panel/share-links/${link.id}`)).toBeUndefined();
    const after = listOf(await call('GET', '/panel/share-links?targetType=report&targetId=rep_sample_signups')) as Array<{ id: string; revokedAt: string | null }>;
    expect(after.find((l) => l.id === link.id)?.revokedAt).not.toBeNull();
    expect(await call('GET', '/panel/share-links/pnsl_sample_a1')).toBe(UNHANDLED);
  });
});

describe('WeldPanel sample data: monitoring and data out', () => {
  const create = async (path: string, body: unknown): Promise<{ id: string }> => dataOf(await call('POST', path, body)) as { id: string };
  const condition = { type: 'threshold', operator: 'above', value: 10 };

  it('creates, edits, snoozes, tests and deletes alerts', async () => {
    const alert = await create('/panel/alerts', { projectId: WEBSITE, name: 'Alert', reportId: 'rep_sample_signups', condition, checkInterval: 'hourly', channels: { emailUserIds: ['u1'], inApp: true, slackWebhookUrl: 'https://hooks.example.com/x' } });
    await create('/panel/alerts', { projectId: WEBSITE, name: 'Paused', condition, checkInterval: 'weekly', enabled: false });
    await create('/panel/alerts', { projectId: WEBSITE, name: 'Default', condition });
    expect(alertShape.parse(dataOf(await call('GET', `/panel/alerts/${alert.id}`)))).toMatchObject({ state: 'pending' });
    expect(dataOf(await call('PATCH', `/panel/alerts/${alert.id}`, { name: 'Renamed', enabled: false, checkInterval: 'daily', reportId: 'rep_sample_retention', channels: { emailUserIds: [] } }))).toMatchObject({ name: 'Renamed', enabled: false, nextCheckAt: null });
    expect(dataOf(await call('PATCH', `/panel/alerts/${alert.id}`, { enabled: true, condition: { type: 'anomaly', sensitivity: 'high' }, seriesIndex: 1 }))).toMatchObject({ enabled: true, seriesIndex: 1 });
    expect(dataOf(await call('POST', `/panel/alerts/${alert.id}/snooze`, { until: '2026-12-01T00:00:00Z' }))).toMatchObject({ snoozedUntil: '2026-12-01T00:00:00Z' });
    expect(dataOf(await call('POST', `/panel/alerts/${alert.id}/snooze`, {}))).toMatchObject({ snoozedUntil: null });
    expect(dataOf(await call('POST', `/panel/alerts/${alert.id}/test`))).toHaveProperty('delivered');
    expect(await call('DELETE', `/panel/alerts/${alert.id}`)).toBeUndefined();
    await expect(call('GET', `/panel/alerts/${alert.id}`)).rejects.toBeInstanceOf(Error);
  });

  it('makes a failing alert show its history', async () => {
    const events = listOf(await call('GET', '/panel/alerts/pnal_sample_demos/events')) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toContain('error');
  });

  it('creates, edits, sends and deletes subscriptions', async () => {
    const channels = { emailUserIds: ['u1'] };
    const weekly = await create('/panel/subscriptions', { projectId: WEBSITE, name: 'Weekly', targetType: 'report', targetId: 'rep_sample_signups', schedule: { frequency: 'weekly', weekday: 2, hour: 9 }, channels });
    await create('/panel/subscriptions', { projectId: WEBSITE, name: 'Monthly', targetType: 'report', targetId: 'rep_sample_signups', schedule: { frequency: 'monthly', monthDay: 3, hour: 9, timezone: 'UTC' }, enabled: false });
    await create('/panel/subscriptions', { projectId: WEBSITE, name: 'Daily', targetType: 'report', targetId: 'rep_sample_signups', schedule: { frequency: 'daily', hour: 3 } });
    expect(subscriptionShape.parse(dataOf(await call('GET', `/panel/subscriptions/${weekly.id}`)))).toBeDefined();
    expect(dataOf(await call('PATCH', `/panel/subscriptions/${weekly.id}`, { name: 'Daily now', schedule: { frequency: 'daily', hour: 5 }, channels: { inApp: false, emailUserIds: [] }, enabled: false }))).toMatchObject({ name: 'Daily now', enabled: false, nextRunAt: null });
    expect(dataOf(await call('PATCH', '/panel/subscriptions/pnsb_sample_vitals', { enabled: true }))).toMatchObject({ enabled: true });
    const sent = dataOf(await call('POST', '/panel/subscriptions/pnsb_sample_marketing/send-now')) as { delivered: Array<{ channel: string; ok: boolean }> };
    expect(sent.delivered.find((d) => d.channel === 'slack')?.ok).toBe(false);
    const fine = dataOf(await call('POST', '/panel/subscriptions/pnsb_sample_signups/send-now')) as { delivered: Array<{ ok: boolean }> };
    expect(fine.delivered.every((d) => d.ok)).toBe(true);
    expect(await call('DELETE', `/panel/subscriptions/${weekly.id}`)).toBeUndefined();
  });

  it('creates, edits, pauses, resumes, tests and deletes exports', async () => {
    const bucket = { provider: 's3', region: 'eu-west-1', bucket: 'sample-bucket', accessKeyId: 'AKIASAMPLE' };
    const exported = await create('/panel/exports', { projectId: WEBSITE, name: 'Export', destination: bucket, tables: ['events', 'events', 'people'], frequency: 'hourly' });
    await create('/panel/exports', { projectId: WEBSITE, name: 'R2', destination: { ...bucket, provider: 'r2', endpoint: 'https://abc.r2.cloudflarestorage.com', region: 'auto', prefix: 'p', pathStyle: true }, tables: ['events'], startAt: '2026-11-01T00:00:00Z' });
    const stored = dataOf(await call('GET', `/panel/exports/${exported.id}`)) as { tables: string[] };
    expect(exportShape.parse(stored)).toBeDefined();
    expect(stored.tables).toEqual(['events', 'people']);
    expect(dataOf(await call('PATCH', `/panel/exports/${exported.id}`, { name: 'Renamed', destination: bucket, tables: ['events'], frequency: 'daily' }))).toMatchObject({ name: 'Renamed', frequency: 'daily' });
    expect(dataOf(await call('PATCH', '/panel/exports/pnex_sample_r2', {}))).toMatchObject({ id: 'pnex_sample_r2' });
    expect(dataOf(await call('POST', `/panel/exports/${exported.id}/pause`))).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(dataOf(await call('POST', '/panel/exports/pnex_sample_gcs/resume'))).toMatchObject({ status: 'active', lastError: null });
    expect(dataOf(await call('POST', '/panel/exports/test', { exportId: 'pnex_sample_minio' }))).toMatchObject({ ok: false });
    expect(dataOf(await call('POST', '/panel/exports/test', { exportId: 'pnex_sample_minio', secretAccessKey: 's' }))).toMatchObject({ ok: true });
    expect(dataOf(await call('POST', '/panel/exports/test', {}))).toMatchObject({ ok: true });
    expect(await call('DELETE', `/panel/exports/${exported.id}`)).toBeUndefined();
  });

  it('adds a collector domain that turns active on the first check', async () => {
    const domain = dataOf(await call('POST', `/panel/projects/${WEBSITE}/domains`, { hostname: ' Stats.Example.COM ' })) as { id: string; hostname: string; status: string; snippet: string | null };
    expect(domain).toMatchObject({ hostname: 'stats.example.com', status: 'pending', snippet: null });
    const refreshed = dataOf(await call('POST', `/panel/projects/${WEBSITE}/domains/${domain.id}/refresh`)) as { status: string; snippet: string };
    expect(refreshed.status).toBe('active');
    expect(refreshed.snippet).toContain('stats.example.com');
    const again = dataOf(await call('POST', `/panel/projects/${WEBSITE}/domains/${domain.id}/refresh`)) as { status: string };
    expect(again.status).toBe('active');
    expect(dataOf(await call('POST', `/panel/projects/${WEBSITE}/domains`, {}))).toMatchObject({ hostname: 'stats.example.com' });
    expect(await call('DELETE', `/panel/projects/${WEBSITE}/domains/${domain.id}`)).toBeUndefined();
    await expect(call('DELETE', `/panel/projects/${WEBSITE}/domains/${domain.id}`)).rejects.toBeInstanceOf(Error);
    expect(listOf(await call('GET', `/panel/projects/${WEBSITE}/domains`)).length).toBeGreaterThan(0);
  });
});
