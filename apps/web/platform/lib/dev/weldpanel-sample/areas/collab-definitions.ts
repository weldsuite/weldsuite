/**
 * Sample answers for WeldPanel definitions and collaboration: custom events,
 * computed properties, path rules, annotations, comments, report versions,
 * metric trees and share links. State lives in module-level arrays, so a
 * create, update or delete shows up in later calls during the session.
 */

import type {
  CreatePanelAnnotationInput,
  CreatePanelCommentInput,
  CreatePanelComputedPropertyInput,
  CreatePanelCustomEventInput,
  CreatePanelMetricTreeInput,
  CreatePanelShareLinkInput,
  ParsedPanelMetricTreeNode,
  PanelAnnotationDto,
  PanelCommentDto,
  PanelComputedPropertyDto,
  PanelCreatedShareLinkDto,
  PanelCustomEventDto,
  PanelMetricTreeDto,
  PanelPathRuleDto,
  PanelReportVersionDetailDto,
  PanelReportVersionDto,
  PanelShareLinkDto,
  PanelTargetType,
  SetPanelPathRulesInput,
  TestPanelPathRulesInput,
  UpdatePanelAnnotationInput,
  UpdatePanelCommentInput,
  UpdatePanelComputedPropertyInput,
  UpdatePanelCustomEventInput,
  UpdatePanelMetricTreeInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { applyPanelPathRules, panelShareUrl } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { ParsedTrendsSpec, PanelReportSpecKind, PanelTrendMath } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { UNHANDLED, type SampleAreaHandler, type SampleRequest } from '../request';
import { defaultSpec } from './objects-specs';
import { bodyAs, notFound, orKeep, removeAt, routeResource, type CollectionContext, type ItemContext, type ResourceRoutes } from './collab-routes';
import {
  APP_PROJECT_ID,
  DASHBOARD_REFS,
  MEMBERS,
  REPORT_REFS,
  WEBSITE_PROJECT_ID,
  data,
  isoDaysAgo,
  isoMinutesAgo,
  list,
  randomToken,
  rng,
  sampleId,
} from '../dataset';

const ME = MEMBERS[0].userId;

function member(index: number): string {
  return MEMBERS[index % MEMBERS.length]!.userId;
}

function projectOfTarget(type: PanelTargetType, id: string): string {
  const ref = type === 'report' ? REPORT_REFS.find((r) => r.id === id) : DASHBOARD_REFS.find((d) => d.id === id);
  return ref?.projectId ?? WEBSITE_PROJECT_ID;
}

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

function customEvent(id: string, projectId: string, name: string, description: string, match: PanelCustomEventDto['definition']['match'], days: number, owner: number): PanelCustomEventDto {
  return {
    id,
    projectId,
    name,
    description,
    definition: { match },
    ref: `@${id}`,
    ownerUserId: member(owner),
    createdAt: isoDaysAgo(days, 11, 20),
    updatedAt: isoDaysAgo(Math.max(0, days - 9), 15, 5),
  };
}

const customEvents: PanelCustomEventDto[] = [
  customEvent('pnce_sample_lead', WEBSITE_PROJECT_ID, 'Lead', 'Anyone who left their details: demo request, newsletter or a new account', [
    { event: 'demo_requested', filters: [] },
    { event: 'newsletter_subscribed', filters: [] },
    { event: 'signup_completed', filters: [] },
  ], 96, 1),
  customEvent('pnce_sample_pricing_view', WEBSITE_PROJECT_ID, 'Pricing page view', 'A page view of the pricing page', [
    { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/pricing' }] },
  ], 74, 0),
  customEvent('pnce_sample_nl_signup', WEBSITE_PROJECT_ID, 'Dutch sign-up', 'Sign-ups from the Netherlands', [
    { event: 'signup_completed', filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] },
  ], 61, 1),
  customEvent('pnce_sample_campaign_signup', WEBSITE_PROJECT_ID, 'Campaign sign-up', 'Sign-ups that came with a campaign tag', [
    { event: 'signup_completed', filters: [{ source: 'column', field: 'utm_campaign', operator: 'is_set' }] },
  ], 45, 2),
  customEvent('pnce_sample_docs_visit', WEBSITE_PROJECT_ID, 'Docs visit', 'Any page under /docs', [
    { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'contains', value: '/docs' }] },
  ], 38, 3),
  customEvent('pnce_sample_paid', APP_PROJECT_ID, 'Became a paying customer', 'Upgraded or paid for the first time', [
    { event: 'plan_upgraded', filters: [] },
    { event: 'checkout_completed', filters: [] },
  ], 120, 0),
  customEvent('pnce_sample_mobile_invoice', APP_PROJECT_ID, 'Invoice sent from a phone', 'Invoices sent from a mobile device', [
    { event: 'invoice_sent', filters: [{ source: 'column', field: 'device_type', operator: 'eq', value: 'mobile' }] },
  ], 52, 2),
];

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

function computed(id: string, projectId: string, name: string, description: string | null, definition: PanelComputedPropertyDto['definition'], days: number, owner: number): PanelComputedPropertyDto {
  return {
    id,
    projectId,
    name,
    description,
    definition,
    ref: `@${id}`,
    ownerUserId: member(owner),
    createdAt: isoDaysAgo(days, 9, 40),
    updatedAt: isoDaysAgo(Math.max(0, days - 12), 14, 30),
  };
}

const computedProperties: PanelComputedPropertyDto[] = [
  computed('pncp_sample_order_value', APP_PROJECT_ID, 'Order value', 'Price times quantity of an order line', { kind: 'formula', expression: 'price * quantity' }, 88, 1),
  computed('pncp_sample_net_revenue', APP_PROJECT_ID, 'Net revenue', 'What was paid after the discount', { kind: 'formula', expression: 'amount - discount' }, 70, 1),
  computed('pncp_sample_discount_pct', APP_PROJECT_ID, 'Discount percentage', null, { kind: 'formula', expression: 'discount / (price * quantity) * 100' }, 41, 3),
  computed('pncp_sample_revenue_per_seat', APP_PROJECT_ID, 'Revenue per seat', 'Monthly revenue divided by paid seats', { kind: 'formula', expression: 'mrr / seats' }, 33, 0),
  computed('pncp_sample_plan_name', APP_PROJECT_ID, 'Plan name', 'The plan, whichever property the event used', {
    kind: 'coalesce',
    keys: [{ source: 'event', key: 'plan' }, { source: 'event', key: '$plan_name' }],
  }, 58, 2),
  computed('pncp_sample_traffic_source', WEBSITE_PROJECT_ID, 'Campaign or source', 'The campaign when there is one, otherwise the source', {
    kind: 'coalesce',
    keys: [{ source: 'column', field: 'utm_campaign' }, { source: 'column', field: 'utm_source' }, { source: 'column', field: 'referrer_host' }],
  }, 47, 1),
];

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

function rules(projectId: string, items: Array<[string, string, string | null]>): PanelPathRuleDto[] {
  return items.map(([pattern, replacement, description], position) => ({
    id: `pnpr_${projectId.slice(-4)}_${position}`,
    projectId,
    position,
    pattern,
    replacement,
    description,
    createdByUserId: member(position),
    createdAt: isoDaysAgo(80 - position * 6, 10, 0),
    updatedAt: isoDaysAgo(20 - position, 10, 0),
  }));
}

const pathRules = new Map<string, PanelPathRuleDto[]>([
  [
    WEBSITE_PROJECT_ID,
    rules(WEBSITE_PROJECT_ID, [
      ['^/(nl|de|fr)/', '/', 'Drop the language prefix'],
      ['^/blog/[^/]+$', '/blog/:slug', 'One line for every blog post'],
      ['^/customers/[a-z0-9-]+$', '/customers/:name', 'Customer stories'],
      ['^/docs/.+', '/docs/:page', 'Documentation pages'],
      ['^/invite/[A-Za-z0-9]+', '/invite/:code', null],
      ['/index\\.html$', '', 'Old static URLs'],
    ]),
  ],
  [
    APP_PROJECT_ID,
    rules(APP_PROJECT_ID, [
      ['^/weldcrm/companies/[A-Za-z0-9_]+', '/weldcrm/companies/:id', 'Company detail'],
      ['^/welddesk/tickets/[A-Za-z0-9_]+', '/welddesk/tickets/:id', 'Ticket detail'],
      ['^/weldbooks/invoices/[A-Za-z0-9_]+', '/weldbooks/invoices/:id', null],
      ['^/weldflow/projects/[A-Za-z0-9_]+', '/weldflow/projects/:id', 'Project board'],
    ]),
  ],
]);

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

function annotation(id: string, projectId: string, reportId: string | null, days: number, label: string, description: string | null, owner: number): PanelAnnotationDto {
  return {
    id,
    projectId,
    reportId,
    occurredAt: isoDaysAgo(days, 9, 0),
    label,
    description,
    createdByUserId: member(owner),
    createdAt: isoDaysAgo(days, 9, 30),
    updatedAt: isoDaysAgo(days, 9, 30),
  };
}

const annotations: PanelAnnotationDto[] = [
  annotation('pnan_sample_1', WEBSITE_PROJECT_ID, null, 1, 'Fixed sign-up bug', 'The Safari sign-up button did nothing for two days. Fixed in the 14:00 release.', 3),
  annotation('pnan_sample_2', WEBSITE_PROJECT_ID, null, 4, 'Newsletter sent', 'November newsletter to 8,400 subscribers.', 1),
  annotation('pnan_sample_3', WEBSITE_PROJECT_ID, null, 9, 'Black Friday campaign starts', 'Paid search and LinkedIn campaign for the annual plan discount.', 0),
  annotation('pnan_sample_4', WEBSITE_PROJECT_ID, null, 14, 'Launched new pricing page', 'Three plans instead of four, annual price shown first.', 0),
  annotation('pnan_sample_5', WEBSITE_PROJECT_ID, null, 21, 'Product Hunt launch', null, 1),
  annotation('pnan_sample_6', WEBSITE_PROJECT_ID, null, 33, 'Cookie banner updated', 'Consent is now asked before any tracking starts.', 3),
  annotation('pnan_sample_7', WEBSITE_PROJECT_ID, 'rep_sample_signups', 17, 'Tracking paused for 3 hours', 'Release went out with a broken script. No data for this window.', 2),
  annotation('pnan_sample_8', WEBSITE_PROJECT_ID, 'rep_sample_trial_funnel', 12, 'Trial length moved to 30 days', 'Was 14 days before.', 0),
  annotation('pnan_sample_9', APP_PROJECT_ID, null, 3, 'WeldCRM import released', null, 2),
  annotation('pnan_sample_10', APP_PROJECT_ID, null, 16, 'New onboarding checklist', 'Every new workspace now sees a five-step checklist on the home screen.', 3),
  annotation('pnan_sample_11', APP_PROJECT_ID, null, 28, 'Outage in the EU region', 'About 40 minutes, 10:20 to 11:00.', 1),
  annotation('pnan_sample_12', APP_PROJECT_ID, 'rep_sample_retention', 24, 'Weekly digest email introduced', 'Expect a bump in week-two retention.', 0),
];

/** A day (`YYYY-MM-DD`, UTC) or an instant as a time; `end` makes a day run to its last millisecond. */
function parseBound(value: string, end: boolean): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value).getTime();
  const time = end ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${value}T${time}Z`).getTime();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

const COMMENT_POOL: ReadonlyArray<{ body: string; edited?: boolean }> = [
  { body: 'The bump around the 14th is the pricing page launch. I marked it on the chart.' },
  { body: 'Can we split this by country? I think most of the growth is Dutch small businesses.' },
  { body: 'Good idea. I added a breakdown by country, check the second tab.', edited: true },
  { body: 'Weekends are low as expected, so I would not read much into the dip on Saturday.' },
  { body: 'We should put this on the Growth dashboard for Monday.' },
  { body: 'Done. It is the second tile from the top now.' },
  { body: 'The drop-off between step 2 and 3 looks high compared with last month. Anyone know why?' },
  { body: 'That is the new trial form with the extra company field. Product is testing a shorter version.' },
  { body: '**Note:** numbers before the 3rd exclude the Safari visitors because of the tracking bug.' },
  { body: 'Thanks, I will mention that in the board update.' },
  { body: 'Is this report using the cleaned paths? Blog posts show up as separate rows for me.' },
  { body: 'Yes, but the new slug rule was added after. Refresh and it should group them.' },
];

function seedComments(): PanelCommentDto[] {
  const out: PanelCommentDto[] = [];
  const targets: Array<{ type: PanelTargetType; id: string; projectId: string }> = [
    ...REPORT_REFS.map((r) => ({ type: 'report' as const, id: r.id, projectId: r.projectId })),
    ...DASHBOARD_REFS.map((d) => ({ type: 'dashboard' as const, id: d.id, projectId: d.projectId })),
  ];
  targets.forEach((target, t) => {
    const random = rng(`comments-${target.id}`);
    const count = 2 + Math.floor(random() * 3);
    const start = (t * 3) % COMMENT_POOL.length;
    for (let i = 0; i < count; i++) {
      const item = COMMENT_POOL[(start + i) % COMMENT_POOL.length]!;
      const days = Math.max(0, 12 - t - i * 2);
      const at = isoDaysAgo(days, 9 + ((t + i * 3) % 8), (t * 17 + i * 11) % 60);
      out.push({
        id: `pncm_${target.id.slice(-12)}_${i}`,
        projectId: target.projectId,
        targetType: target.type,
        targetId: target.id,
        body: item.body,
        authorUserId: member(t + i),
        edited: item.edited ?? false,
        createdAt: at,
        updatedAt: item.edited ? isoDaysAgo(Math.max(0, days - 1), 9, 5) : at,
      });
    }
  });
  return out;
}

const comments: PanelCommentDto[] = seedComments();

// ---------------------------------------------------------------------------
// Report versions
// ---------------------------------------------------------------------------

type VersionStore = Array<PanelReportVersionDetailDto>;

const SPEC_FOR_KIND: Record<string, (projectId: string) => Record<string, unknown>> = {
  trends: (projectId) => ({
    kind: 'trends',
    projectId,
    dateRange: { preset: '30d' },
    series: [{ event: 'signup_completed', math: 'total' }],
    interval: 'day',
  }),
  funnel: (projectId) => ({
    kind: 'funnel',
    projectId,
    dateRange: { preset: '30d' },
    steps: [{ event: '$pageview' }, { event: 'signup_started' }, { event: 'signup_completed' }, { event: 'checkout_completed' }],
  }),
  retention: (projectId) => ({ kind: 'retention', projectId, dateRange: { preset: '90d' }, firstEvent: 'workspace_created', returnEvent: '$pageview', interval: 'week' }),
};

function specFor(kind: string, projectId: string, step: number): Record<string, unknown> {
  // The other kinds (flows, stickiness, …) have no versions of their own: they use the report's stock spec.
  const make = SPEC_FOR_KIND[kind] ?? ((id: string): Record<string, unknown> => ({ ...defaultSpec(kind as PanelReportSpecKind, id) }));
  const spec = make(projectId);
  return step % 2 === 0 ? spec : { ...spec, dateRange: { preset: step % 3 === 0 ? '7d' : '90d' } };
}

const CHANGE_NOTES = [
  'Added a breakdown by country',
  'Changed the date range to the last 90 days',
  'Renamed after the product team asked for a clearer title',
  'Added the paid-plan step',
  'Filtered out internal traffic',
  'Switched from total to unique users',
  'Compared with the previous period',
  'First saved version',
];

/** The first version is a draft, the ones between are named by number now and then, the last is the report itself. */
function versionName(reportName: string, version: number, count: number): string {
  if (version === 1) return `${reportName} (draft)`;
  if (version >= count) return reportName;
  return version % 2 ? `${reportName} - v${version}` : reportName;
}

function seedVersions(): Map<string, VersionStore> {
  const out = new Map<string, VersionStore>();
  REPORT_REFS.forEach((report, r) => {
    const count = 3 + (r % 4);
    const versions: VersionStore = [];
    for (let v = 1; v <= count; v++) {
      const age = (count - v) * 6 + 3 + r;
      const name = versionName(report.name, v, count);
      versions.push({
        id: `pnrv_${report.id.slice(-10)}_${v}`,
        reportId: report.id,
        version: v,
        name,
        description: CHANGE_NOTES[(r + v) % CHANGE_NOTES.length]!,
        kind: report.kind,
        createdByUserId: member(r + v),
        createdAt: isoDaysAgo(age, 10 + (v % 6), (v * 13) % 60),
        spec: specFor(report.kind, report.projectId, v),
      });
    }
    out.set(report.id, versions);
  });
  return out;
}

const versionsByReport = seedVersions();

function versionSummary(version: PanelReportVersionDetailDto): PanelReportVersionDto {
  return {
    id: version.id,
    reportId: version.reportId,
    version: version.version,
    name: version.name,
    description: version.description,
    kind: version.kind,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Metric trees
// ---------------------------------------------------------------------------

function trendsMetric(projectId: string, event: string, math: PanelTrendMath = 'total'): { spec: ParsedTrendsSpec } {
  return {
    spec: {
      kind: 'trends',
      projectId,
      dateRange: { preset: '30d' },
      timezone: 'Europe/Amsterdam',
      filters: [],
      series: [{ event, math, filters: [] }],
      interval: 'day',
      compare: false,
    },
  };
}

function node(id: string, label: string, parentId: string | null, relation: ParsedPanelMetricTreeNode['relation'], metric: ParsedPanelMetricTreeNode['metric']): ParsedPanelMetricTreeNode {
  return { id, label, parentId, relation, metric };
}

function tree(id: string, projectId: string, name: string, description: string | null, visibility: PanelMetricTreeDto['visibility'], days: number, owner: number, nodes: ParsedPanelMetricTreeNode[]): PanelMetricTreeDto {
  return { id, projectId, name, description, nodes, ownerUserId: member(owner), visibility, createdAt: isoDaysAgo(days, 10, 0), updatedAt: isoDaysAgo(Math.max(0, days - 8), 16, 20) };
}

const W = WEBSITE_PROJECT_ID;
const A = APP_PROJECT_ID;

/** A saved metric tree by id, so the query area values its own nodes. */
export function sampleMetricTree(id: string): PanelMetricTreeDto | undefined {
  return metricTrees.find((tree) => tree.id === id);
}

const metricTrees: PanelMetricTreeDto[] = [
  tree('pnmt_sample_customers', W, 'New paying customers', 'North star for the growth team: what drives people to pay', 'workspace', 62, 0, [
    node('root', 'Paying customers', null, null, trendsMetric(W, 'checkout_completed', 'unique_users')),
    node('trials', 'Trials started', 'root', 'product', trendsMetric(W, 'trial_started', 'unique_users')),
    node('signups', 'Accounts created', 'trials', 'sum', trendsMetric(W, 'signup_completed', 'unique_users')),
    node('signup_form', 'Opened the sign-up form', 'signups', 'influence', trendsMetric(W, 'signup_started', 'unique_users')),
    node('demos', 'Demo requests', 'root', 'sum', trendsMetric(W, 'demo_requested', 'total')),
    node('pricing', 'Pricing page visitors', 'root', 'influence', { reportId: 'rep_sample_trial_funnel' }),
  ]),
  tree('pnmt_sample_active', A, 'Teams that get real work done', 'Weekly active workspaces and the habits behind them', 'workspace', 48, 1, [
    node('root', 'Active workspaces', null, null, { reportId: 'rep_sample_module_usage' }),
    node('tickets', 'Tickets created', 'root', 'sum', trendsMetric(A, 'ticket_created', 'total')),
    node('mail', 'Emails sent', 'root', 'sum', trendsMetric(A, 'email_sent', 'total')),
    node('invoices', 'Invoices sent', 'root', 'sum', trendsMetric(A, 'invoice_sent', 'total')),
    node('invites', 'Teammates invited', 'root', 'influence', trendsMetric(A, 'member_invited', 'total')),
    node('modules', 'Modules installed', 'root', 'influence', trendsMetric(A, 'module_installed', 'unique_users')),
  ]),
  tree('pnmt_sample_leads', W, 'Marketing leads', null, 'private', 30, 2, [
    node('root', 'Leads', null, null, trendsMetric(W, 'signup_completed', 'total')),
    node('newsletter', 'Newsletter sign-ups', 'root', 'sum', trendsMetric(W, 'newsletter_subscribed', 'total')),
    node('demo', 'Demo requests', 'root', 'sum', trendsMetric(W, 'demo_requested', 'total')),
    node('started', 'Started the sign-up form', 'root', 'influence', trendsMetric(W, 'signup_started', 'total')),
  ]),
  tree('pnmt_sample_revenue', A, 'Revenue growth', 'From trial to paid plan', 'workspace', 20, 0, [
    node('root', 'Plan upgrades', null, null, trendsMetric(A, 'plan_upgraded', 'total')),
    node('trial', 'Trials started in the app', 'root', 'product', trendsMetric(A, 'trial_started', 'unique_users')),
    node('workspace', 'Workspaces created', 'trial', 'influence', trendsMetric(A, 'workspace_created', 'total')),
    node('checkout', 'Checkouts completed', 'root', 'sum', trendsMetric(A, 'checkout_completed', 'total')),
  ]),
];

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

interface StoredShareLink extends PanelShareLinkDto {
  token: string;
}

function shareLink(id: string, type: PanelTargetType, targetId: string, days: number, opts: Partial<PanelShareLinkDto>, owner: number): StoredShareLink {
  const token = `wpsh_${id.replace(/[^A-Za-z0-9]/g, '').padEnd(32, 'x').slice(0, 32)}`;
  return {
    id,
    projectId: projectOfTarget(type, targetId),
    targetType: type,
    targetId,
    prefix: `${token.slice(0, 9)}…`,
    allowEmbed: false,
    allowDateChange: false,
    expiresAt: null,
    revokedAt: null,
    lastViewedAt: null,
    viewCount: 0,
    createdByUserId: member(owner),
    createdAt: isoDaysAgo(days, 11, 0),
    token,
    ...opts,
  };
}

const shareLinks: StoredShareLink[] = [
  shareLink('pnsl_sample_a1', 'report', 'rep_sample_signups', 19, { allowDateChange: true, viewCount: 142, lastViewedAt: isoMinutesAgo(190) }, 0),
  shareLink('pnsl_sample_a2', 'report', 'rep_sample_signups', 40, { allowEmbed: true, expiresAt: isoDaysAgo(5, 0, 0), viewCount: 37, lastViewedAt: isoDaysAgo(6, 15, 10) }, 1),
  shareLink('pnsl_sample_a3', 'report', 'rep_sample_signups', 55, { revokedAt: isoDaysAgo(30, 9, 0), viewCount: 9, lastViewedAt: isoDaysAgo(31, 14, 0) }, 0),
  shareLink('pnsl_sample_b1', 'dashboard', 'dash_sample_growth', 11, { allowEmbed: true, allowDateChange: true, expiresAt: isoDaysAgo(-20, 0, 0), viewCount: 86, lastViewedAt: isoMinutesAgo(1400) }, 0),
  shareLink('pnsl_sample_b2', 'dashboard', 'dash_sample_marketing', 26, { viewCount: 14, lastViewedAt: isoDaysAgo(4, 11, 20) }, 2),
  shareLink('pnsl_sample_c1', 'report', 'rep_sample_trial_funnel', 8, { viewCount: 3, lastViewedAt: isoDaysAgo(2, 16, 45) }, 3),
];

function shareLinkDto(link: StoredShareLink): PanelShareLinkDto {
  return {
    id: link.id,
    projectId: link.projectId,
    targetType: link.targetType,
    targetId: link.targetId,
    prefix: link.prefix,
    allowEmbed: link.allowEmbed,
    allowDateChange: link.allowDateChange,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastViewedAt: link.lastViewedAt,
    viewCount: link.viewCount,
    createdByUserId: link.createdByUserId,
    createdAt: link.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function matchesOf(definition: CreatePanelCustomEventInput['definition']): PanelCustomEventDto['definition'] {
  return { match: definition.match.map((m) => ({ event: m.event, filters: m.filters ?? [] })) };
}

function createCustomEvent({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelCustomEventInput>(request.body);
  const id = sampleId('pnce');
  const created: PanelCustomEventDto = {
    id,
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    definition: matchesOf(input.definition),
    ref: `@${id}`,
    ownerUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
  customEvents.unshift(created);
  return data(created);
}

function updateCustomEvent({ request, current, index, now }: ItemContext<PanelCustomEventDto>): unknown {
  const input = bodyAs<UpdatePanelCustomEventInput>(request.body);
  const updated: PanelCustomEventDto = {
    ...current,
    name: input.name ?? current.name,
    description: orKeep(input.description, current.description),
    definition: input.definition ? matchesOf(input.definition) : current.definition,
    updatedAt: now,
  };
  customEvents[index] = updated;
  return data(updated);
}

const customEventRoutes: ResourceRoutes<PanelCustomEventDto> = {
  items: customEvents,
  what: 'custom event',
  collection: {
    GET: ({ request }) => list(customEvents.filter((e) => e.projectId === request.query.get('projectId'))),
    POST: createCustomEvent,
  },
  item: {
    GET: ({ current }) => data(current),
    PATCH: updateCustomEvent,
    DELETE: ({ index }) => removeAt(customEvents, index),
  },
};

function createComputedProperty({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelComputedPropertyInput>(request.body);
  const id = sampleId('pncp');
  const created: PanelComputedPropertyDto = {
    id,
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    definition: input.definition,
    ref: `@${id}`,
    ownerUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
  computedProperties.unshift(created);
  return data(created);
}

function updateComputedProperty({ request, current, index, now }: ItemContext<PanelComputedPropertyDto>): unknown {
  const input = bodyAs<UpdatePanelComputedPropertyInput>(request.body);
  const updated: PanelComputedPropertyDto = {
    ...current,
    name: input.name ?? current.name,
    description: orKeep(input.description, current.description),
    definition: input.definition ?? current.definition,
    updatedAt: now,
  };
  computedProperties[index] = updated;
  return data(updated);
}

const computedPropertyRoutes: ResourceRoutes<PanelComputedPropertyDto> = {
  items: computedProperties,
  what: 'computed property',
  collection: {
    GET: ({ request }) => list(computedProperties.filter((p) => p.projectId === request.query.get('projectId'))),
    POST: createComputedProperty,
  },
  item: {
    GET: ({ current }) => data(current),
    PATCH: updateComputedProperty,
    DELETE: ({ index }) => removeAt(computedProperties, index),
  },
};

function testPathRules(body: unknown): unknown {
  const input = bodyAs<TestPanelPathRulesInput>(body);
  const active = input.rules ?? pathRules.get(input.projectId ?? WEBSITE_PROJECT_ID) ?? [];
  return data({ results: (input.paths ?? []).map((path) => ({ path, ...applyPanelPathRules(path, active) })).map((r) => ({ path: r.path, cleaned: r.cleaned, matched: r.matched })) });
}

function setPathRules(projectId: string, input: SetPanelPathRulesInput): PanelPathRuleDto[] {
  const now = new Date().toISOString();
  const next: PanelPathRuleDto[] = (input.rules ?? []).map((rule, position) => ({
    id: `pnpr_${sampleId('r')}`,
    projectId,
    position,
    pattern: rule.pattern,
    replacement: rule.replacement,
    description: rule.description ?? null,
    createdByUserId: ME,
    createdAt: now,
    updatedAt: now,
  }));
  pathRules.set(projectId, next);
  return next;
}

function handlePathRules({ method, segments, query, body }: SampleRequest): unknown {
  if (segments[1] === 'test' && method === 'POST') return testPathRules(body);
  if (segments.length !== 1) return UNHANDLED;
  const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
  if (method === 'GET') return list(pathRules.get(projectId) ?? []);
  if (method === 'PUT') return list(setPathRules(projectId, bodyAs<SetPanelPathRulesInput>(body)));
  return UNHANDLED;
}

/** The annotations of a project that fall in the asked-for window and belong to no report or the asked-for one. */
function annotationsFor(query: URLSearchParams): PanelAnnotationDto[] {
  const projectId = query.get('projectId');
  const from = query.get('from');
  const to = query.get('to');
  const reportId = query.get('reportId');
  const occurred = (a: PanelAnnotationDto) => new Date(a.occurredAt).getTime();
  return annotations
    .filter((a) => a.projectId === projectId)
    .filter((a) => a.reportId === null || a.reportId === reportId)
    .filter((a) => (from ? occurred(a) >= parseBound(from, false) : true))
    .filter((a) => (to ? occurred(a) <= parseBound(to, true) : true))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function createAnnotation({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelAnnotationInput>(request.body);
  const created: PanelAnnotationDto = {
    id: sampleId('pnan'),
    projectId: input.projectId,
    reportId: input.reportId ?? null,
    occurredAt: input.occurredAt,
    label: input.label,
    description: input.description ?? null,
    createdByUserId: ME,
    createdAt: now,
    updatedAt: now,
  };
  annotations.push(created);
  return data(created);
}

function updateAnnotation({ request, current, index, now }: ItemContext<PanelAnnotationDto>): unknown {
  const input = bodyAs<UpdatePanelAnnotationInput>(request.body);
  const updated: PanelAnnotationDto = {
    ...current,
    reportId: orKeep(input.reportId, current.reportId),
    occurredAt: input.occurredAt ?? current.occurredAt,
    label: input.label ?? current.label,
    description: orKeep(input.description, current.description),
    updatedAt: now,
  };
  annotations[index] = updated;
  return data(updated);
}

const annotationRoutes: ResourceRoutes<PanelAnnotationDto> = {
  items: annotations,
  what: 'annotation',
  collection: {
    GET: ({ request }) => list(annotationsFor(request.query)),
    POST: createAnnotation,
  },
  item: {
    GET: ({ current }) => data(current),
    PATCH: updateAnnotation,
    DELETE: ({ index }) => removeAt(annotations, index),
  },
};

function commentsOf({ request }: CollectionContext): unknown {
  const type = request.query.get('targetType');
  const targetId = request.query.get('targetId');
  return list(comments.filter((c) => c.targetType === type && c.targetId === targetId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

function createComment({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelCommentInput>(request.body);
  const created: PanelCommentDto = {
    id: sampleId('pncm'),
    projectId: projectOfTarget(input.targetType, input.targetId),
    targetType: input.targetType,
    targetId: input.targetId,
    body: input.body,
    authorUserId: ME,
    edited: false,
    createdAt: now,
    updatedAt: now,
  };
  comments.push(created);
  return data(created);
}

function updateComment({ request, current, index, now }: ItemContext<PanelCommentDto>): unknown {
  const input = bodyAs<UpdatePanelCommentInput>(request.body);
  const updated: PanelCommentDto = { ...current, body: input.body ?? current.body, edited: true, updatedAt: now };
  comments[index] = updated;
  return data(updated);
}

const commentRoutes: ResourceRoutes<PanelCommentDto> = {
  items: comments,
  what: 'comment',
  collection: { GET: commentsOf, POST: createComment },
  item: {
    PATCH: updateComment,
    DELETE: ({ index }) => removeAt(comments, index),
  },
};

/** One version of a report, or a "not found" error. */
function versionOf(versions: VersionStore, number: number): PanelReportVersionDetailDto {
  const found = versions.find((v) => v.version === number);
  if (!found) throw notFound('version');
  return found;
}

/** Puts a copy of an old version on top of the history and returns the report as it is now. */
function restoreVersion(reportId: string, versions: VersionStore, number: number, now: string): PanelReportDto {
  const found = versions.find((v) => v.version === number);
  const ref = REPORT_REFS.find((r) => r.id === reportId);
  if (!found || !ref) throw notFound('version');
  const top = Math.max(...versions.map((v) => v.version));
  versions.push({ ...found, id: sampleId('pnrv'), version: top + 1, description: `Before restoring version ${number}`, createdByUserId: ME, createdAt: now });
  return {
    id: reportId,
    projectId: ref.projectId,
    kind: ref.kind,
    name: found.name,
    description: found.description,
    spec: found.spec,
    ownerUserId: member(0),
    visibility: 'workspace',
    createdAt: isoDaysAgo(60, 10, 0),
    updatedAt: now,
  };
}

function handleReportVersions({ method, segments }: SampleRequest): unknown {
  const [, id, third, fourth] = segments;
  if (third !== 'versions' || !id) return UNHANDLED;
  const versions = versionsByReport.get(id);
  if (!versions) return UNHANDLED;
  if (segments.length === 3 && method === 'GET') return list(versions.map(versionSummary).sort((a, b) => b.version - a.version));
  const number = Number(fourth);
  if (segments.length === 4 && method === 'GET') return data(versionOf(versions, number));
  if (segments.length === 5 && segments[4] === 'restore' && method === 'POST') return data(restoreVersion(id, versions, number, new Date().toISOString()));
  return UNHANDLED;
}

/** `mine`: the ones you own; `shared`: other people's that the workspace can see; anything else: all. */
function treeInScope(tree: PanelMetricTreeDto, scope: string | null): boolean {
  if (scope === 'mine') return tree.ownerUserId === ME;
  if (scope === 'shared') return tree.visibility === 'workspace' && tree.ownerUserId !== ME;
  return true;
}

function createMetricTree({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelMetricTreeInput>(request.body);
  const created: PanelMetricTreeDto = {
    id: sampleId('pnmt'),
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    nodes: input.nodes as ParsedPanelMetricTreeNode[],
    ownerUserId: ME,
    visibility: input.visibility ?? 'private',
    createdAt: now,
    updatedAt: now,
  };
  metricTrees.unshift(created);
  return data(created);
}

function updateMetricTree({ request, current, index, now }: ItemContext<PanelMetricTreeDto>): unknown {
  const input = bodyAs<UpdatePanelMetricTreeInput>(request.body);
  const updated: PanelMetricTreeDto = {
    ...current,
    name: input.name ?? current.name,
    description: orKeep(input.description, current.description),
    visibility: input.visibility ?? current.visibility,
    nodes: input.nodes ? (input.nodes as ParsedPanelMetricTreeNode[]) : current.nodes,
    updatedAt: now,
  };
  metricTrees[index] = updated;
  return data(updated);
}

const metricTreeRoutes: ResourceRoutes<PanelMetricTreeDto> = {
  items: metricTrees,
  what: 'metric tree',
  collection: {
    GET: ({ request }) => list(metricTrees.filter((t) => t.projectId === request.query.get('projectId')).filter((t) => treeInScope(t, request.query.get('scope')))),
    POST: createMetricTree,
  },
  item: {
    GET: ({ current }) => data(current),
    PATCH: updateMetricTree,
    DELETE: ({ index }) => removeAt(metricTrees, index),
  },
};

function shareLinksOf({ request }: CollectionContext): unknown {
  const type = request.query.get('targetType');
  const targetId = request.query.get('targetId');
  return list(shareLinks.filter((l) => l.targetType === type && l.targetId === targetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(shareLinkDto));
}

function createShareLink({ request, now }: CollectionContext): unknown {
  const input = bodyAs<CreatePanelShareLinkInput>(request.body);
  const token = `wpsh_${randomToken(32)}`;
  const created: StoredShareLink = {
    id: sampleId('pnsl'),
    projectId: projectOfTarget(input.targetType, input.targetId),
    targetType: input.targetType,
    targetId: input.targetId,
    prefix: `${token.slice(0, 9)}…`,
    allowEmbed: input.allowEmbed ?? false,
    allowDateChange: input.allowDateChange ?? false,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    lastViewedAt: null,
    viewCount: 0,
    createdByUserId: ME,
    createdAt: now,
    token,
  };
  shareLinks.unshift(created);
  const response: PanelCreatedShareLinkDto = { ...shareLinkDto(created), token, url: panelShareUrl(window.location.origin, token) };
  return data(response);
}

function revokeShareLink({ index, now }: ItemContext<StoredShareLink>): undefined {
  shareLinks[index] = { ...shareLinks[index]!, revokedAt: now };
  return undefined;
}

const shareLinkRoutes: ResourceRoutes<StoredShareLink> = {
  items: shareLinks,
  what: 'share link',
  methodFirst: true,
  collection: { GET: shareLinksOf, POST: createShareLink },
  item: { DELETE: revokeShareLink },
};

/** Each area's handler, by the first path segment. */
const AREA_HANDLERS: Record<string, SampleAreaHandler> = {
  'custom-events': (request) => routeResource(request, customEventRoutes),
  'computed-properties': (request) => routeResource(request, computedPropertyRoutes),
  'path-rules': handlePathRules,
  annotations: (request) => routeResource(request, annotationRoutes),
  comments: (request) => routeResource(request, commentRoutes),
  reports: handleReportVersions,
  'metric-trees': (request) => routeResource(request, metricTreeRoutes),
  'share-links': (request) => routeResource(request, shareLinkRoutes),
};

export const handleDefinitions: SampleAreaHandler = (request) => {
  const area = request.segments[0];
  const handler = area !== undefined && Object.hasOwn(AREA_HANDLERS, area) ? AREA_HANDLERS[area] : undefined;
  return handler ? handler(request) : UNHANDLED;
};
