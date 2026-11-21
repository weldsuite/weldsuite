import { describe, expect, it } from 'vitest';
import type { ClientApi } from '../types';
import { createWeldPanelMonitorApi, type WeldPanelMonitorApi } from './weldpanel-monitor';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RecordedCall {
  method: Method;
  path: string;
  body?: unknown;
}

const RESPONSE = { data: 'from the fake api' };

function recordingApi(): { api: ClientApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (method: Method) =>
    <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return Promise.resolve(RESPONSE as T);
    };
  const api: ClientApi = {
    get: record('GET'),
    getRaw: () => Promise.reject(new Error('getRaw is not used by the WeldPanel monitor client')),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    postForm: () => Promise.reject(new Error('postForm is not used by the WeldPanel monitor client')),
  };
  return { api, calls };
}

const ALERT = {
  projectId: 'pnp_1',
  name: 'Sign-ups dropped',
  reportId: 'pnr_1',
  condition: { type: 'change' as const, direction: 'decrease' as const, percent: 30 },
  channels: { emailUserIds: ['user_1'] },
};
const SUBSCRIPTION = {
  projectId: 'pnp_1',
  name: 'Monday numbers',
  targetType: 'dashboard' as const,
  targetId: 'pnd_1',
  schedule: { frequency: 'weekly' as const, hour: 8, weekday: 1 },
  channels: { inApp: true },
};
const DESTINATION = { provider: 's3' as const, region: 'eu-west-1', bucket: 'panel-exports', accessKeyId: 'AKIAEXAMPLE' };
const EXPORT = {
  projectId: 'pnp_1',
  name: 'Raw events',
  destination: DESTINATION,
  secretAccessKey: 'test-secret',
  tables: ['events' as const],
};

const CASES: { name: string; call: (client: WeldPanelMonitorApi) => Promise<unknown>; expected: RecordedCall }[] = [
  // Alerts
  {
    name: 'alerts.list with params',
    call: (c) => c.alerts.list({ projectId: 'pnp_1', scope: 'mine' }),
    expected: { method: 'GET', path: '/panel/alerts?projectId=pnp_1&scope=mine' },
  },
  { name: 'alerts.list without params', call: (c) => c.alerts.list(), expected: { method: 'GET', path: '/panel/alerts' } },
  { name: 'alerts.get', call: (c) => c.alerts.get('pna_1'), expected: { method: 'GET', path: '/panel/alerts/pna_1' } },
  { name: 'alerts.create', call: (c) => c.alerts.create(ALERT), expected: { method: 'POST', path: '/panel/alerts', body: ALERT } },
  {
    name: 'alerts.update',
    call: (c) => c.alerts.update('pna_1', { enabled: false }),
    expected: { method: 'PATCH', path: '/panel/alerts/pna_1', body: { enabled: false } },
  },
  { name: 'alerts.remove', call: (c) => c.alerts.remove('pna_1'), expected: { method: 'DELETE', path: '/panel/alerts/pna_1' } },
  {
    name: 'alerts.events with a page',
    call: (c) => c.alerts.events('pna_1', { cursor: 'abc', limit: 20 }),
    expected: { method: 'GET', path: '/panel/alerts/pna_1/events?cursor=abc&limit=20' },
  },
  {
    name: 'alerts.events without a page',
    call: (c) => c.alerts.events('pna_1'),
    expected: { method: 'GET', path: '/panel/alerts/pna_1/events' },
  },
  { name: 'alerts.test', call: (c) => c.alerts.test('pna_1'), expected: { method: 'POST', path: '/panel/alerts/pna_1/test', body: {} } },
  {
    name: 'alerts.snooze',
    call: (c) => c.alerts.snooze('pna_1', { until: '2026-12-01T00:00:00Z' }),
    expected: { method: 'POST', path: '/panel/alerts/pna_1/snooze', body: { until: '2026-12-01T00:00:00Z' } },
  },

  // Subscriptions
  {
    name: 'subscriptions.list with params',
    call: (c) => c.subscriptions.list({ projectId: 'pnp_1', targetType: 'report', targetId: 'pnr_1', scope: 'all' }),
    expected: { method: 'GET', path: '/panel/subscriptions?projectId=pnp_1&targetType=report&targetId=pnr_1&scope=all' },
  },
  { name: 'subscriptions.list without params', call: (c) => c.subscriptions.list(), expected: { method: 'GET', path: '/panel/subscriptions' } },
  { name: 'subscriptions.get', call: (c) => c.subscriptions.get('pns_1'), expected: { method: 'GET', path: '/panel/subscriptions/pns_1' } },
  {
    name: 'subscriptions.create',
    call: (c) => c.subscriptions.create(SUBSCRIPTION),
    expected: { method: 'POST', path: '/panel/subscriptions', body: SUBSCRIPTION },
  },
  {
    name: 'subscriptions.update',
    call: (c) => c.subscriptions.update('pns_1', { name: 'Tuesday numbers' }),
    expected: { method: 'PATCH', path: '/panel/subscriptions/pns_1', body: { name: 'Tuesday numbers' } },
  },
  {
    name: 'subscriptions.remove',
    call: (c) => c.subscriptions.remove('pns_1'),
    expected: { method: 'DELETE', path: '/panel/subscriptions/pns_1' },
  },
  {
    name: 'subscriptions.sendNow',
    call: (c) => c.subscriptions.sendNow('pns_1'),
    expected: { method: 'POST', path: '/panel/subscriptions/pns_1/send-now', body: {} },
  },

  // Exports
  { name: 'exports.list', call: (c) => c.exports.list('pnp_1'), expected: { method: 'GET', path: '/panel/exports?projectId=pnp_1' } },
  { name: 'exports.get', call: (c) => c.exports.get('pnx_1'), expected: { method: 'GET', path: '/panel/exports/pnx_1' } },
  { name: 'exports.create', call: (c) => c.exports.create(EXPORT), expected: { method: 'POST', path: '/panel/exports', body: EXPORT } },
  {
    name: 'exports.update',
    call: (c) => c.exports.update('pnx_1', { frequency: 'hourly' }),
    expected: { method: 'PATCH', path: '/panel/exports/pnx_1', body: { frequency: 'hourly' } },
  },
  { name: 'exports.remove', call: (c) => c.exports.remove('pnx_1'), expected: { method: 'DELETE', path: '/panel/exports/pnx_1' } },
  {
    name: 'exports.runs with a page',
    call: (c) => c.exports.runs('pnx_1', { limit: 5 }),
    expected: { method: 'GET', path: '/panel/exports/pnx_1/runs?limit=5' },
  },
  { name: 'exports.runs without a page', call: (c) => c.exports.runs('pnx_1'), expected: { method: 'GET', path: '/panel/exports/pnx_1/runs' } },
  { name: 'exports.pause', call: (c) => c.exports.pause('pnx_1'), expected: { method: 'POST', path: '/panel/exports/pnx_1/pause', body: {} } },
  { name: 'exports.resume', call: (c) => c.exports.resume('pnx_1'), expected: { method: 'POST', path: '/panel/exports/pnx_1/resume', body: {} } },
  {
    name: 'exports.test',
    call: (c) => c.exports.test({ exportId: 'pnx_1' }),
    expected: { method: 'POST', path: '/panel/exports/test', body: { exportId: 'pnx_1' } },
  },

  // Custom collector domains
  { name: 'domains.list', call: (c) => c.domains.list('pnp_1'), expected: { method: 'GET', path: '/panel/projects/pnp_1/domains' } },
  {
    name: 'domains.create',
    call: (c) => c.domains.create('pnp_1', { hostname: 'stats.example.com' }),
    expected: { method: 'POST', path: '/panel/projects/pnp_1/domains', body: { hostname: 'stats.example.com' } },
  },
  {
    name: 'domains.refresh',
    call: (c) => c.domains.refresh('pnp_1', 'pndm_1'),
    expected: { method: 'POST', path: '/panel/projects/pnp_1/domains/pndm_1/refresh', body: {} },
  },
  {
    name: 'domains.remove',
    call: (c) => c.domains.remove('pnp_1', 'pndm_1'),
    expected: { method: 'DELETE', path: '/panel/projects/pnp_1/domains/pndm_1' },
  },
];

describe('WeldPanel monitor client', () => {
  it.each(CASES)('$name sends $expected.method $expected.path', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    await expect(call(createWeldPanelMonitorApi(api))).resolves.toBe(RESPONSE);
    expect(calls).toEqual([expected]);
  });
});
