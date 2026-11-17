import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientApi } from '../types';
import {
  createWeldPanelCollabApi,
  createWeldPanelPublicShareApi,
  PanelPublicShareError,
  type WeldPanelCollabApi,
} from './weldpanel-collab';

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
    getRaw: () => Promise.reject(new Error('getRaw is not used by the WeldPanel collab client')),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    postForm: () => Promise.reject(new Error('postForm is not used by the WeldPanel collab client')),
  };
  return { api, calls };
}

const CUSTOM_EVENT = { projectId: 'pnp_1', name: 'Converted', definition: { match: [{ event: 'Signed up' }, { event: 'Purchase' }] } };
const COMPUTED = { projectId: 'pnp_1', name: 'Line total', definition: { kind: 'formula' as const, expression: 'price * quantity' } };
const RULES = { rules: [{ pattern: '^/users/\\d+', replacement: '/users/:id' }] };
const ANNOTATION = { projectId: 'pnp_1', occurredAt: '2026-11-01T09:00:00Z', label: 'Launch' };
const COMMENT = { targetType: 'report' as const, targetId: 'pnr_1', body: 'Why the dip?' };
const TREE = {
  projectId: 'pnp_1',
  name: 'Revenue tree',
  nodes: [{ id: 'root', label: 'Revenue', parentId: null, relation: null, metric: { reportId: 'pnr_1' } }],
};
const SHARE = { targetType: 'dashboard' as const, targetId: 'pnd_1', allowEmbed: true };

const CASES: { name: string; call: (client: WeldPanelCollabApi) => Promise<unknown>; expected: RecordedCall }[] = [
  // Custom events
  {
    name: 'customEvents.list',
    call: (c) => c.customEvents.list('pnp_1'),
    expected: { method: 'GET', path: '/panel/custom-events?projectId=pnp_1' },
  },
  { name: 'customEvents.get', call: (c) => c.customEvents.get('pnce_1'), expected: { method: 'GET', path: '/panel/custom-events/pnce_1' } },
  {
    name: 'customEvents.create',
    call: (c) => c.customEvents.create(CUSTOM_EVENT),
    expected: { method: 'POST', path: '/panel/custom-events', body: CUSTOM_EVENT },
  },
  {
    name: 'customEvents.update',
    call: (c) => c.customEvents.update('pnce_1', { description: null }),
    expected: { method: 'PATCH', path: '/panel/custom-events/pnce_1', body: { description: null } },
  },
  {
    name: 'customEvents.remove',
    call: (c) => c.customEvents.remove('pnce_1'),
    expected: { method: 'DELETE', path: '/panel/custom-events/pnce_1' },
  },

  // Computed properties
  {
    name: 'computedProperties.list',
    call: (c) => c.computedProperties.list('pnp_1'),
    expected: { method: 'GET', path: '/panel/computed-properties?projectId=pnp_1' },
  },
  {
    name: 'computedProperties.get',
    call: (c) => c.computedProperties.get('pncp_1'),
    expected: { method: 'GET', path: '/panel/computed-properties/pncp_1' },
  },
  {
    name: 'computedProperties.create',
    call: (c) => c.computedProperties.create(COMPUTED),
    expected: { method: 'POST', path: '/panel/computed-properties', body: COMPUTED },
  },
  {
    name: 'computedProperties.update',
    call: (c) => c.computedProperties.update('pncp_1', { name: 'Total' }),
    expected: { method: 'PATCH', path: '/panel/computed-properties/pncp_1', body: { name: 'Total' } },
  },
  {
    name: 'computedProperties.remove',
    call: (c) => c.computedProperties.remove('pncp_1'),
    expected: { method: 'DELETE', path: '/panel/computed-properties/pncp_1' },
  },

  // Path rules
  { name: 'pathRules.list', call: (c) => c.pathRules.list('pnp_1'), expected: { method: 'GET', path: '/panel/path-rules?projectId=pnp_1' } },
  {
    name: 'pathRules.replace',
    call: (c) => c.pathRules.replace('pnp_1', RULES),
    expected: { method: 'PUT', path: '/panel/path-rules?projectId=pnp_1', body: RULES },
  },
  {
    name: 'pathRules.test',
    call: (c) => c.pathRules.test({ projectId: 'pnp_1', paths: ['/users/42'] }),
    expected: { method: 'POST', path: '/panel/path-rules/test', body: { projectId: 'pnp_1', paths: ['/users/42'] } },
  },

  // Annotations
  {
    name: 'annotations.list',
    call: (c) => c.annotations.list({ projectId: 'pnp_1', from: '2026-11-01', to: '2026-11-30', reportId: 'pnr_1' }),
    expected: { method: 'GET', path: '/panel/annotations?projectId=pnp_1&from=2026-11-01&to=2026-11-30&reportId=pnr_1' },
  },
  { name: 'annotations.get', call: (c) => c.annotations.get('pnan_1'), expected: { method: 'GET', path: '/panel/annotations/pnan_1' } },
  {
    name: 'annotations.create',
    call: (c) => c.annotations.create(ANNOTATION),
    expected: { method: 'POST', path: '/panel/annotations', body: ANNOTATION },
  },
  {
    name: 'annotations.update',
    call: (c) => c.annotations.update('pnan_1', { label: 'Launch v2' }),
    expected: { method: 'PATCH', path: '/panel/annotations/pnan_1', body: { label: 'Launch v2' } },
  },
  {
    name: 'annotations.remove',
    call: (c) => c.annotations.remove('pnan_1'),
    expected: { method: 'DELETE', path: '/panel/annotations/pnan_1' },
  },

  // Comments
  {
    name: 'comments.list',
    call: (c) => c.comments.list({ targetType: 'report', targetId: 'pnr_1' }),
    expected: { method: 'GET', path: '/panel/comments?targetType=report&targetId=pnr_1' },
  },
  { name: 'comments.create', call: (c) => c.comments.create(COMMENT), expected: { method: 'POST', path: '/panel/comments', body: COMMENT } },
  {
    name: 'comments.update',
    call: (c) => c.comments.update('pncm_1', { body: 'Fixed' }),
    expected: { method: 'PATCH', path: '/panel/comments/pncm_1', body: { body: 'Fixed' } },
  },
  { name: 'comments.remove', call: (c) => c.comments.remove('pncm_1'), expected: { method: 'DELETE', path: '/panel/comments/pncm_1' } },

  // Report versions
  {
    name: 'reportVersions.list',
    call: (c) => c.reportVersions.list('pnr_1'),
    expected: { method: 'GET', path: '/panel/reports/pnr_1/versions' },
  },
  {
    name: 'reportVersions.get',
    call: (c) => c.reportVersions.get('pnr_1', 3),
    expected: { method: 'GET', path: '/panel/reports/pnr_1/versions/3' },
  },
  {
    name: 'reportVersions.restore',
    call: (c) => c.reportVersions.restore('pnr_1', 3),
    expected: { method: 'POST', path: '/panel/reports/pnr_1/versions/3/restore', body: {} },
  },

  // Metric trees
  {
    name: 'metricTrees.list',
    call: (c) => c.metricTrees.list({ projectId: 'pnp_1', scope: 'shared' }),
    expected: { method: 'GET', path: '/panel/metric-trees?projectId=pnp_1&scope=shared' },
  },
  { name: 'metricTrees.get', call: (c) => c.metricTrees.get('pnmt_1'), expected: { method: 'GET', path: '/panel/metric-trees/pnmt_1' } },
  { name: 'metricTrees.create', call: (c) => c.metricTrees.create(TREE), expected: { method: 'POST', path: '/panel/metric-trees', body: TREE } },
  {
    name: 'metricTrees.update',
    call: (c) => c.metricTrees.update('pnmt_1', { visibility: 'workspace' }),
    expected: { method: 'PATCH', path: '/panel/metric-trees/pnmt_1', body: { visibility: 'workspace' } },
  },
  {
    name: 'metricTrees.remove',
    call: (c) => c.metricTrees.remove('pnmt_1'),
    expected: { method: 'DELETE', path: '/panel/metric-trees/pnmt_1' },
  },

  // Share links
  {
    name: 'shareLinks.list',
    call: (c) => c.shareLinks.list({ targetType: 'dashboard', targetId: 'pnd_1' }),
    expected: { method: 'GET', path: '/panel/share-links?targetType=dashboard&targetId=pnd_1' },
  },
  { name: 'shareLinks.create', call: (c) => c.shareLinks.create(SHARE), expected: { method: 'POST', path: '/panel/share-links', body: SHARE } },
  { name: 'shareLinks.revoke', call: (c) => c.shareLinks.revoke('pnsl_1'), expected: { method: 'DELETE', path: '/panel/share-links/pnsl_1' } },
];

describe('WeldPanel collab client', () => {
  it.each(CASES)('$name sends $expected.method $expected.path', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    await expect(call(createWeldPanelCollabApi(api))).resolves.toBe(RESPONSE);
    expect(calls).toEqual([expected]);
  });
});

// ---------------------------------------------------------------------------
// Public share client
// ---------------------------------------------------------------------------

interface SentRequest {
  url: string;
  init: RequestInit | undefined;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    sent.push({ url: urlOf(input), init });
    return Promise.resolve(respond());
  };
  return { fetch: fetchImpl, sent };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TOKEN = 'wpsh_abcdefghijklmnopqrstuvwxyz012345';

describe('WeldPanel public share client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a link with a credential-free GET and unwraps `data`', async () => {
    const share = { targetType: 'report', name: 'Visits' };
    const { fetch: fetchImpl, sent } = fakeFetch(() => json(200, { data: share }));
    const client = createWeldPanelPublicShareApi({ baseUrl: 'https://panel-api.example.com//', fetch: fetchImpl });

    await expect(client.get(TOKEN)).resolves.toEqual(share);
    expect(sent).toEqual([
      {
        url: `https://panel-api.example.com/public/panel/share/${TOKEN}`,
        init: { method: 'GET', credentials: 'omit', cache: 'no-store', headers: undefined, body: undefined },
      },
    ]);
  });

  it('posts the results input as JSON, an empty object by default, with the token encoded', async () => {
    const { fetch: fetchImpl, sent } = fakeFetch(() => json(200, { data: { kind: 'trends', cached: false } }));
    const client = createWeldPanelPublicShareApi({ baseUrl: 'https://panel-api.example.com', fetch: fetchImpl });

    await expect(client.results('a/b', { tileId: 'pndt_1', dateRange: { preset: '7d' } })).resolves.toEqual({ kind: 'trends', cached: false });
    await client.results(TOKEN);

    expect(sent.map((r) => r.url)).toEqual([
      'https://panel-api.example.com/public/panel/share/a%2Fb/results',
      `https://panel-api.example.com/public/panel/share/${TOKEN}/results`,
    ]);
    expect(sent[0]?.init).toEqual({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tileId: 'pndt_1', dateRange: { preset: '7d' } }),
    });
    expect(sent[1]?.init?.body).toBe('{}');
  });

  it('throws the API error message and code, and says when the link is gone', async () => {
    const { fetch: fetchImpl } = fakeFetch(() => json(404, { error: { code: 'NOT_FOUND', message: 'This link no longer works' } }));
    const client = createWeldPanelPublicShareApi({ baseUrl: 'https://panel-api.example.com', fetch: fetchImpl });

    const error = await client.get(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelPublicShareError);
    expect(error).toMatchObject({ name: 'PanelPublicShareError', message: 'This link no longer works', status: 404, code: 'NOT_FOUND' });
    expect(error instanceof PanelPublicShareError && error.isNotFound).toBe(true);
    expect(error instanceof PanelPublicShareError && error.isRateLimited).toBe(false);
  });

  it('says when the viewer is rate limited', async () => {
    const { fetch: fetchImpl } = fakeFetch(() => json(429, { error: { code: 'RATE_LIMITED', message: 'Slow down' } }));
    const client = createWeldPanelPublicShareApi({ baseUrl: 'https://panel-api.example.com', fetch: fetchImpl });

    const error = await client.results(TOKEN).catch((e: unknown) => e);
    expect(error instanceof PanelPublicShareError && error.isRateLimited).toBe(true);
    expect(error instanceof PanelPublicShareError && error.isNotFound).toBe(false);
  });

  it('falls back to the status when the error body is not JSON or has no usable message', async () => {
    const notJson = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const badShape = fakeFetch(() => json(500, { error: { code: 42, message: { text: 'nested' } } }));

    await expect(createWeldPanelPublicShareApi({ baseUrl: 'https://p.example.com', fetch: notJson.fetch }).get(TOKEN)).rejects.toMatchObject({
      message: 'Request failed with status 502',
      status: 502,
      code: null,
    });
    await expect(createWeldPanelPublicShareApi({ baseUrl: 'https://p.example.com', fetch: badShape.fetch }).get(TOKEN)).rejects.toMatchObject({
      message: 'Request failed with status 500',
      status: 500,
      code: null,
    });
  });

  it('uses the global fetch when none is given', async () => {
    const stubbed = fakeFetch(() => json(200, { data: { name: 'Shared dashboard' } }));
    vi.stubGlobal('fetch', stubbed.fetch);
    const client = createWeldPanelPublicShareApi({ baseUrl: 'https://panel-api.example.com' });

    await expect(client.get(TOKEN)).resolves.toEqual({ name: 'Shared dashboard' });
    expect(stubbed.sent.map((r) => r.url)).toEqual([`https://panel-api.example.com/public/panel/share/${TOKEN}`]);
  });
});
