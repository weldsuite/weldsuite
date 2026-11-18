import { describe, expect, it } from 'vitest';
import type { ClientApi } from '../types';
import { createWeldPanelAnalysisApi, type WeldPanelAnalysisApi } from './weldpanel-analysis';

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
    getRaw: () => Promise.reject(new Error('getRaw is not used by the WeldPanel analysis client')),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    postForm: () => Promise.reject(new Error('postForm is not used by the WeldPanel analysis client')),
  };
  return { api, calls };
}

const TRENDS = { kind: 'trends' as const, projectId: 'pnp_1', series: [{ event: '$pageview' }] };
const NODES = [{ id: 'root', label: 'Visits', parentId: null, relation: null, metric: { spec: TRENDS } }];

const CASES: { name: string; call: (client: WeldPanelAnalysisApi) => Promise<unknown>; expected: RecordedCall }[] = [
  {
    name: 'insights.explain',
    call: (c) => c.insights.explain({ projectId: 'pnp_1', spec: TRENDS, bucket: '2026-11-01' }),
    expected: { method: 'POST', path: '/panel/insights/explain', body: { projectId: 'pnp_1', spec: TRENDS, bucket: '2026-11-01' } },
  },
  {
    name: 'metricTreeValues.preview',
    call: (c) => c.metricTreeValues.preview({ projectId: 'pnp_1', nodes: NODES }),
    expected: { method: 'POST', path: '/panel/metric-tree-values', body: { projectId: 'pnp_1', nodes: NODES } },
  },
  {
    name: 'metricTreeValues.get with a period',
    call: (c) => c.metricTreeValues.get('pnmt_1', { dateRange: { preset: '7d' } }),
    expected: { method: 'POST', path: '/panel/metric-tree-values/pnmt_1', body: { dateRange: { preset: '7d' } } },
  },
  {
    name: 'metricTreeValues.get without a period',
    call: (c) => c.metricTreeValues.get('tree/1'),
    expected: { method: 'POST', path: '/panel/metric-tree-values/tree%2F1', body: {} },
  },
];

describe('WeldPanel analysis client', () => {
  it.each(CASES)('$name sends $expected.method $expected.path', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    await expect(call(createWeldPanelAnalysisApi(api))).resolves.toBe(RESPONSE);
    expect(calls).toEqual([expected]);
  });
});
