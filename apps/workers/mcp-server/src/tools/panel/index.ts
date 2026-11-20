import { z } from 'zod';
import { PANEL_DATE_PRESETS, PANEL_QUERY_KINDS, PANEL_REPORT_SPEC_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ToolDefinition } from '../registry';

/**
 * WeldPanel tools (product analytics), read-only: projects, ad-hoc queries,
 * saved reports and their results, dashboards, cohorts, the event lexicon,
 * and tracked people. They call the server's copy of external-api's
 * `/v1/panel` (src/api/routes/v1/panel), which reads through panel-api's
 * internal API as the signed-in member: their private reports, and people
 * only with `panel_people:read`.
 */

const projectId = z.string().describe('The WeldPanel project — its id from weldpanel_list_projects');
const reportId = z.string().describe('The saved report — its id from weldpanel_list_reports');

export const panelTools: ToolDefinition[] = [
  {
    name: 'weldpanel_list_projects',
    scope: 'panel:read',
    description: 'List the WeldPanel projects (tracked websites and apps) of the workspace: id, name, kind and status.',
    inputSchema: {},
    method: 'GET',
    path: '/v1/panel/projects',
  },
  {
    name: 'weldpanel_query',
    scope: 'panel:read',
    description:
      'Run a WeldPanel analytics query from a typed spec (never SQL). `spec.kind` is one of: ' +
      `${PANEL_QUERY_KINDS.join(', ')}. Every spec has \`projectId\`, an optional \`dateRange\` ({ preset: today|7d|30d|90d|12m } or { from, to } as YYYY-MM-DD), ` +
      '`timezone` and `filters`. Trends: `series` [{ event, math?, property?, filters? }], `interval` hour|day|week|month, `breakdown`. ' +
      'Funnel: `steps` [{ event }] (2–10), `window`. Retention: `firstEvent`, `returnEvent`, `interval`, `periods`. ' +
      'Web: the website overview (visitors, pages, sources, countries). Event names come from weldpanel_list_events.',
    inputSchema: {
      spec: z.record(z.unknown()).describe('The query spec, e.g. { "kind": "trends", "projectId": "…", "series": [{ "event": "$pageview" }], "dateRange": { "preset": "30d" } }'),
    },
    method: 'POST',
    path: '/v1/panel/query',
  },
  {
    name: 'weldpanel_list_reports',
    scope: 'panel:read',
    description: 'List saved WeldPanel reports the user can see (theirs and shared ones), optionally for one project or kind.',
    inputSchema: {
      projectId: projectId.optional(),
      kind: z.enum(PANEL_REPORT_SPEC_KINDS).optional().describe('Only reports of this kind'),
      scope: z.enum(['all', 'mine', 'shared']).optional().describe('all (default), mine, or shared with the workspace'),
    },
    method: 'GET',
    path: '/v1/panel/reports',
  },
  {
    name: 'weldpanel_get_report',
    scope: 'panel:read',
    description: 'Get a saved WeldPanel report: its name, kind and query spec.',
    inputSchema: { id: reportId },
    method: 'GET',
    path: '/v1/panel/reports/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'weldpanel_get_report_results',
    scope: 'panel:read',
    description: 'Run a saved WeldPanel report and return its numbers, as saved or over another date preset.',
    inputSchema: {
      id: reportId,
      preset: z.enum(PANEL_DATE_PRESETS).optional().describe('Run it over this period instead of its saved one'),
    },
    method: 'GET',
    path: '/v1/panel/reports/:id/results',
    pathParams: { id: 'id' },
  },
  {
    name: 'weldpanel_list_dashboards',
    scope: 'panel:read',
    description: 'List WeldPanel dashboards the user can see, optionally for one project.',
    inputSchema: {
      projectId: projectId.optional(),
      scope: z.enum(['all', 'mine', 'shared']).optional(),
    },
    method: 'GET',
    path: '/v1/panel/dashboards',
  },
  {
    name: 'weldpanel_get_dashboard',
    scope: 'panel:read',
    description: 'Get a WeldPanel dashboard with its tiles (the reports on it and their layout).',
    inputSchema: { id: z.string().describe('The dashboard — its id from weldpanel_list_dashboards') },
    method: 'GET',
    path: '/v1/panel/dashboards/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'weldpanel_list_cohorts',
    scope: 'panel:read',
    description: 'List the saved cohorts (groups of tracked people) of a WeldPanel project.',
    inputSchema: { projectId },
    method: 'GET',
    path: '/v1/panel/cohorts',
  },
  {
    name: 'weldpanel_list_events',
    scope: 'panel:read',
    description: 'List the event and property names a WeldPanel project has seen (its lexicon), with the descriptions the team wrote. Use these names in weldpanel_query.',
    inputSchema: { projectId },
    method: 'GET',
    path: '/v1/panel/events',
  },
  {
    name: 'weldpanel_search_people',
    scope: 'panel:read',
    description: 'Search the people a WeldPanel project tracks (by id, email or name). Needs WeldPanel people access. Cursor-paginated.',
    inputSchema: {
      projectId,
      search: z.string().max(200).optional(),
      cohortId: z.string().optional().describe('Only people in this saved cohort'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional(),
    },
    method: 'GET',
    path: '/v1/panel/people',
  },
  {
    name: 'weldpanel_get_person',
    scope: 'panel:read',
    description: 'Get one tracked person of a WeldPanel project: profile properties, first and last seen, recent activity. Needs WeldPanel people access.',
    inputSchema: {
      distinctId: z.string().describe('The person’s distinct id, exactly as weldpanel_search_people returned it'),
      projectId,
    },
    method: 'GET',
    path: '/v1/panel/people/:distinctId',
    pathParams: { distinctId: 'distinctId' },
    // A person is never guessed from a near match.
    exactId: true,
  },
  {
    name: 'weldpanel_list_groups',
    scope: 'panel:read',
    description: 'List the group profiles (companies, accounts) of one group type in a WeldPanel project, with their properties. Needs WeldPanel people access. Cursor-paginated.',
    inputSchema: {
      projectId,
      type: z.string().describe('The group type, e.g. company'),
      search: z.string().max(200).optional(),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
    method: 'GET',
    path: '/v1/panel/groups',
  },
  {
    name: 'weldpanel_get_group',
    scope: 'panel:read',
    description: 'Get one group of a WeldPanel project: its profile, first and last seen, members and recent events. Needs WeldPanel people access.',
    inputSchema: {
      type: z.string().describe('The group type, e.g. company'),
      key: z.string().describe('The group key, exactly as weldpanel_list_groups returned it'),
      projectId,
    },
    method: 'GET',
    path: '/v1/panel/groups/:type/:key',
    pathParams: { type: 'type', key: 'key' },
    exactId: true,
  },
];
