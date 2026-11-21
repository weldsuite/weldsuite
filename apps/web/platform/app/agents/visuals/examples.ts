/**
 * Sample specs for the chat visuals gallery: one per visual type and chart
 * kind, shaped like what the AI sends (`show_*` tool input plus `type`).
 * They double as test fixtures for the renderers.
 */

import type { ChatVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';

export type ExampleKey =
  | 'bar'
  | 'stackedBar'
  | 'horizontalBar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'stats'
  | 'table'
  | 'records';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const EXAMPLES: Record<ExampleKey, ChatVisual> = {
  bar: {
    type: 'chart',
    kind: 'bar',
    title: 'Open tickets per status',
    description: 'Most open tickets are waiting on a customer reply.',
    labels: ['New', 'Open', 'Pending', 'On hold', 'Solved'],
    series: [{ name: 'Tickets', values: [14, 38, 52, 6, 120] }],
    caption: 'All helpdesk channels, today',
  },
  stackedBar: {
    type: 'chart',
    kind: 'bar',
    title: 'Deals won per quarter by region',
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: 'Benelux', values: [42000, 51000, 47500, 63000] },
      { name: 'DACH', values: [21000, 26500, 31000, 29000] },
      { name: 'Nordics', values: [8000, 12500, 9000, 15500] },
    ],
    stacked: true,
    format: { style: 'currency', currency: 'EUR' },
    caption: '2026, closed won',
  },
  horizontalBar: {
    type: 'chart',
    kind: 'bar',
    horizontal: true,
    title: 'Tasks done per person this sprint',
    labels: ['Anna de Vries', 'Bram Jansen', 'Chloé Martin', 'Daan Bakker', 'Eva Visser'],
    series: [{ name: 'Tasks', values: [18, 12, 15, 9, 21] }],
  },
  line: {
    type: 'chart',
    kind: 'line',
    title: 'Website visitors vs sign-ups',
    labels: MONTHS,
    series: [
      { name: 'Visitors', values: [8200, 7900, 9100, 10400, 11800, 11200, 9800, 9400, 12600, 13900, 14200, 15800] },
      { name: 'Sign-ups', values: [310, 290, 355, 410, 468, 452, null, 380, 512, 570, 601, 655] },
    ],
    format: { style: 'compact' },
  },
  area: {
    type: 'chart',
    kind: 'area',
    stacked: true,
    title: 'Monthly recurring revenue by plan',
    labels: MONTHS.slice(0, 8),
    series: [
      { name: 'Starter', values: [3200, 3400, 3550, 3700, 3900, 4100, 4250, 4400] },
      { name: 'Business', values: [8100, 8600, 9300, 9900, 10600, 11200, 11900, 12800] },
      { name: 'Enterprise', values: [12000, 12000, 14500, 14500, 14500, 17000, 17000, 19500] },
    ],
    format: { style: 'currency', currency: 'EUR' },
  },
  pie: {
    type: 'chart',
    kind: 'pie',
    title: 'Where new leads come from',
    labels: ['Website', 'Referral', 'Events', 'LinkedIn', 'Cold outreach'],
    series: [{ name: 'Leads', values: [142, 61, 38, 27, 12] }],
  },
  donut: {
    type: 'chart',
    kind: 'donut',
    title: 'Time logged by project',
    labels: ['Website relaunch', 'Mobile app', 'Support', 'Internal', 'Sales demos', 'Training', 'Admin', 'Research', 'Hiring'],
    series: [{ name: 'Hours', values: [96, 72, 41, 28, 19, 12, 9, 6, 4] }],
    format: { style: 'number', decimals: 0 },
  },
  stats: {
    type: 'stats',
    title: 'This month so far',
    items: [
      { label: 'Revenue', value: 48210, format: { style: 'currency', currency: 'EUR' }, change: 12.5, changeLabel: 'vs last month' },
      { label: 'Open tickets', value: 23, change: -8, changeLabel: 'vs last month', positiveIsGood: false },
      { label: 'Win rate', value: 31.4, format: { style: 'percent' }, change: 2.1 },
      { label: 'Churn', value: 2.3, format: { style: 'percent' }, change: 0.4, positiveIsGood: false },
    ],
  },
  table: {
    type: 'table',
    title: 'Top open deals',
    columns: [
      { label: 'Deal' },
      { label: 'Company' },
      { label: 'Stage' },
      { label: 'Amount', format: { style: 'currency', currency: 'EUR' } },
      { label: 'Probability', format: { style: 'percent' } },
    ],
    rows: [
      ['Platform rollout', 'Acme BV', 'Negotiation', 84000, 70],
      ['Support renewal', 'Globex', 'Proposal', 26500, 50],
      ['Warehouse pilot', 'Initech', 'Qualified', 18000, 25],
      ['Webshop migration', 'Umbrella NV', 'Proposal', 42000, 40],
      ['Helpdesk seats', 'Hooli', 'Negotiation', 12600, 80],
      ['Accounting module', 'Stark & Co', 'Discovery', 9800, 10],
      ['Mail migration', 'Wayne BV', 'Qualified', 7400, 30],
      ['Data warehouse', 'Cyberdyne', 'Proposal', 61000, 35],
      ['Training package', 'Soylent', 'Negotiation', 5200, 85],
      ['API integration', 'Tyrell', 'Discovery', 15800, 15],
      ['Telephony', 'Wonka', 'Qualified', 11200, 20],
      ['Analytics add-on', 'Oscorp', 'Proposal', 8900, 45],
    ],
  },
  records: {
    type: 'records',
    title: 'Tickets waiting longest',
    items: [
      {
        entityType: 'ticket',
        id: 'tkt_example_1',
        label: 'Invoice PDF shows the wrong VAT number',
        subtitle: 'Acme BV · Anna de Vries',
        status: 'Pending',
        fields: [
          { label: 'Waiting', value: '3 days' },
          { label: 'Priority', value: 'High' },
        ],
      },
      {
        entityType: 'task',
        id: 'tsk_example_2',
        label: 'Call Globex about the renewal',
        subtitle: 'Sales · Bram Jansen',
        status: 'To do',
        fields: [{ label: 'Due', value: 'Tomorrow' }],
      },
      {
        entityType: 'opportunity',
        id: 'opp_example_3',
        label: 'Platform rollout',
        subtitle: 'Acme BV',
        status: 'Negotiation',
        fields: [{ label: 'Amount', value: '€ 84,000' }],
      },
    ],
  },
};

export const EXAMPLE_ORDER: ExampleKey[] = [
  'bar',
  'stackedBar',
  'horizontalBar',
  'line',
  'area',
  'pie',
  'donut',
  'stats',
  'table',
  'records',
];
