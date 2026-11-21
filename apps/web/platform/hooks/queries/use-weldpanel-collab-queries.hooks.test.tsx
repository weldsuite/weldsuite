/**
 * Every collaboration and monitoring hook, table by table: each query calls
 * its client method with the right arguments under the right key and waits
 * for what it needs, and each mutation calls its client method and refreshes
 * (or drops) the queries it changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => {
  const fns = <N extends string>(names: readonly N[]) => Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<N, Mock>;
  return {
    weldpanel: { dashboards: fns(['templates', 'createFromTemplate', 'updateTile']) },
    weldpanelCollab: {
      annotations: fns(['list', 'create', 'update', 'remove']),
      comments: fns(['list', 'create', 'update', 'remove']),
      reportVersions: fns(['list', 'get', 'restore']),
      shareLinks: fns(['list', 'create', 'revoke']),
    },
    weldpanelMonitor: {
      alerts: fns(['list', 'get', 'create', 'update', 'remove', 'events', 'test', 'snooze']),
      subscriptions: fns(['list', 'create', 'update', 'remove', 'sendNow']),
      exports: fns(['list', 'create', 'update', 'remove', 'runs', 'pause', 'resume', 'test']),
      domains: fns(['list', 'create', 'refresh', 'remove']),
    },
  };
});
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@/lib/api/public-env', () => ({ getApiOriginForPath: () => 'https://panel-api.test' }));

import { weldpanelKeys } from './use-weldpanel-queries';
import {
  DOMAIN_POLL_MS,
  useCreateWeldPanelAlert,
  useCreateWeldPanelAnnotation,
  useCreateWeldPanelDashboardFromTemplate,
  useCreateWeldPanelDomain,
  useCreateWeldPanelExport,
  useCreateWeldPanelSubscription,
  useDeleteWeldPanelAlert,
  useDeleteWeldPanelAnnotation,
  useDeleteWeldPanelComment,
  useDeleteWeldPanelDomain,
  useDeleteWeldPanelExport,
  useDeleteWeldPanelSubscription,
  usePauseWeldPanelExport,
  useRefreshWeldPanelDomain,
  useRevokeWeldPanelShareLink,
  useSendWeldPanelSubscriptionNow,
  useSnoozeWeldPanelAlert,
  useTestWeldPanelAlert,
  useTestWeldPanelExport,
  useUpdateWeldPanelAlert,
  useUpdateWeldPanelAnnotation,
  useUpdateWeldPanelComment,
  useUpdateWeldPanelExport,
  useUpdateWeldPanelSubscription,
  useWeldPanelAlert,
  useWeldPanelAlertEvents,
  useWeldPanelAlerts,
  useWeldPanelAnnotations,
  useWeldPanelComments,
  useWeldPanelDashboardTemplates,
  useWeldPanelDomains,
  useWeldPanelExportRuns,
  useWeldPanelExports,
  useWeldPanelPublicResult,
  useWeldPanelPublicShare,
  useWeldPanelReportVersion,
  useWeldPanelReportVersions,
  useWeldPanelShareLinks,
  useWeldPanelSubscriptions,
  weldpanelCollabKeys,
} from './use-weldpanel-collab-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const remove = vi.spyOn(client, 'removeQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  const removed = () => remove.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated, removed };
}

function resetAll(value: unknown) {
  if (typeof value === 'function' && 'mockReset' in value) (value as Mock).mockReset();
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) resetAll(inner);
}

beforeEach(() => resetAll(api));
afterEach(() => vi.restoreAllMocks());

const report = { targetType: 'report' as const, targetId: 'wpr_1' };
const dashboard = { targetType: 'dashboard' as const, targetId: 'wpd_1' };
const channels = { emailUserIds: ['user_1'], inApp: true };
const destination = { provider: 's3' as const, region: 'eu-west-1', bucket: 'events', accessKeyId: 'AKIA' };

interface QueryCase {
  name: string;
  fn: Mock;
  use: () => { data: unknown };
  args: unknown[];
  key: readonly unknown[];
}

const queryCases: QueryCase[] = [
  {
    name: 'annotations of a project and range',
    fn: api.weldpanelCollab.annotations.list,
    use: () => useWeldPanelAnnotations({ projectId: 'wpp_1', reportId: 'wpr_1' }),
    args: [{ projectId: 'wpp_1', reportId: 'wpr_1' }],
    key: weldpanelCollabKeys.annotationList({ projectId: 'wpp_1', reportId: 'wpr_1' }),
  },
  {
    name: 'comments of a report',
    fn: api.weldpanelCollab.comments.list,
    use: () => useWeldPanelComments(report),
    args: [report],
    key: weldpanelCollabKeys.commentList(report),
  },
  {
    name: 'versions of a report',
    fn: api.weldpanelCollab.reportVersions.list,
    use: () => useWeldPanelReportVersions('wpr_1'),
    args: ['wpr_1'],
    key: weldpanelCollabKeys.reportVersions('wpr_1'),
  },
  {
    name: 'one version of a report',
    fn: api.weldpanelCollab.reportVersions.get,
    use: () => useWeldPanelReportVersion('wpr_1', 3),
    args: ['wpr_1', 3],
    key: weldpanelCollabKeys.reportVersion('wpr_1', 3),
  },
  {
    name: 'share links of a dashboard',
    fn: api.weldpanelCollab.shareLinks.list,
    use: () => useWeldPanelShareLinks(dashboard),
    args: [dashboard],
    key: weldpanelCollabKeys.shareLinkList(dashboard),
  },
  {
    name: 'dashboard templates in a language',
    fn: api.weldpanel.dashboards.templates,
    use: () => useWeldPanelDashboardTemplates('nl'),
    args: ['nl'],
    key: weldpanelCollabKeys.dashboardTemplates('nl'),
  },
  {
    name: 'alerts of a project',
    fn: api.weldpanelMonitor.alerts.list,
    use: () => useWeldPanelAlerts({ projectId: 'wpp_1', scope: 'mine' }),
    args: [{ projectId: 'wpp_1', scope: 'mine' }],
    key: weldpanelCollabKeys.alertList({ projectId: 'wpp_1', scope: 'mine' }),
  },
  {
    name: 'one alert',
    fn: api.weldpanelMonitor.alerts.get,
    use: () => useWeldPanelAlert('pnal_1'),
    args: ['pnal_1'],
    key: weldpanelCollabKeys.alert('pnal_1'),
  },
  {
    name: "an alert's latest 50 events",
    fn: api.weldpanelMonitor.alerts.events,
    use: () => useWeldPanelAlertEvents('pnal_1'),
    args: ['pnal_1', { limit: 50 }],
    key: weldpanelCollabKeys.alertEvents('pnal_1'),
  },
  {
    name: 'scheduled reports of a target',
    fn: api.weldpanelMonitor.subscriptions.list,
    use: () => useWeldPanelSubscriptions({ projectId: 'wpp_1', targetType: 'report', targetId: 'wpr_1' }),
    args: [{ projectId: 'wpp_1', targetType: 'report', targetId: 'wpr_1' }],
    key: weldpanelCollabKeys.subscriptionList({ projectId: 'wpp_1', targetType: 'report', targetId: 'wpr_1' }),
  },
  {
    name: 'raw exports of a project',
    fn: api.weldpanelMonitor.exports.list,
    use: () => useWeldPanelExports('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelCollabKeys.exportList('wpp_1'),
  },
  {
    name: "an export's latest 50 runs",
    fn: api.weldpanelMonitor.exports.runs,
    use: () => useWeldPanelExportRuns('pnex_1'),
    args: ['pnex_1', { limit: 50 }],
    key: weldpanelCollabKeys.exportRuns('pnex_1'),
  },
  {
    name: 'collector domains of a project',
    fn: api.weldpanelMonitor.domains.list,
    use: () => useWeldPanelDomains('wpp_1'),
    args: ['wpp_1'],
    key: weldpanelCollabKeys.domains('wpp_1'),
  },
];

describe('queries', () => {
  it.each(queryCases)('$name: calls the client and answers its data under its key', async ({ fn, use, args, key }) => {
    const payload = [{ id: 'x_1', status: 'active' }];
    fn.mockResolvedValue({ data: payload });
    const { client, wrapper } = setup();
    const { result } = renderHook(use, { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(...args);
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeDefined();
  });

  const waiting: { name: string; fn: Mock; use: () => unknown }[] = [
    { name: 'annotations without a project', fn: api.weldpanelCollab.annotations.list, use: () => useWeldPanelAnnotations({ projectId: '' }) },
    { name: 'annotations when switched off', fn: api.weldpanelCollab.annotations.list, use: () => useWeldPanelAnnotations({ projectId: 'wpp_1' }, false) },
    { name: 'comments without a target', fn: api.weldpanelCollab.comments.list, use: () => useWeldPanelComments({ targetType: 'report', targetId: '' }) },
    { name: 'versions without a report', fn: api.weldpanelCollab.reportVersions.list, use: () => useWeldPanelReportVersions('') },
    { name: 'a version not chosen yet', fn: api.weldpanelCollab.reportVersions.get, use: () => useWeldPanelReportVersion('wpr_1', null) },
    { name: 'share links without a target', fn: api.weldpanelCollab.shareLinks.list, use: () => useWeldPanelShareLinks({ targetType: 'dashboard', targetId: '' }) },
    { name: 'templates when switched off', fn: api.weldpanel.dashboards.templates, use: () => useWeldPanelDashboardTemplates('en', false) },
    { name: 'alerts when switched off', fn: api.weldpanelMonitor.alerts.list, use: () => useWeldPanelAlerts({ projectId: 'wpp_1' }, false) },
    { name: 'an alert without an id', fn: api.weldpanelMonitor.alerts.get, use: () => useWeldPanelAlert('') },
    { name: 'alert events without an id', fn: api.weldpanelMonitor.alerts.events, use: () => useWeldPanelAlertEvents('') },
    { name: 'subscriptions when switched off', fn: api.weldpanelMonitor.subscriptions.list, use: () => useWeldPanelSubscriptions({ projectId: 'wpp_1' }, false) },
    { name: 'exports without a project', fn: api.weldpanelMonitor.exports.list, use: () => useWeldPanelExports('') },
    { name: 'export runs without an id', fn: api.weldpanelMonitor.exports.runs, use: () => useWeldPanelExportRuns('') },
    { name: 'domains without a project', fn: api.weldpanelMonitor.domains.list, use: () => useWeldPanelDomains('') },
  ];

  it.each(waiting)('$name: does not call the client', async ({ fn, use }) => {
    const { wrapper } = setup();
    renderHook(use, { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('domain polling', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('re-reads the domains while one is still pending', async () => {
    api.weldpanelMonitor.domains.list.mockResolvedValue({ data: [{ id: 'pndm_1', status: 'pending' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelDomains('wpp_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOMAIN_POLL_MS + 10);
    });
    await waitFor(() => expect(api.weldpanelMonitor.domains.list).toHaveBeenCalledTimes(2));
  });

  it('stops once every domain is settled', async () => {
    api.weldpanelMonitor.domains.list.mockResolvedValue({ data: [{ id: 'pndm_1', status: 'active' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelDomains('wpp_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOMAIN_POLL_MS * 2);
    });
    expect(api.weldpanelMonitor.domains.list).toHaveBeenCalledTimes(1);
  });
});

describe('public share page', () => {
  it("runs a tile's result on the share link, without a session", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { kind: 'trends', result: { series: [] } } }), { status: 200 }));
    const { client, wrapper } = setup();
    const input = { tileId: 'wpt_1', dateRange: { preset: '30d' as const } };
    const { result } = renderHook(() => useWeldPanelPublicResult('wpsh_abc', input), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ kind: 'trends', result: { series: [] } }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://panel-api.test/public/panel/share/wpsh_abc/results');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', body: JSON.stringify(input) });
    expect(client.getQueryCache().find({ queryKey: weldpanelCollabKeys.publicResult('wpsh_abc', input), exact: true })).toBeDefined();
  });

  it('asks nothing without a token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { wrapper } = setup();
    renderHook(() => useWeldPanelPublicShare(''), { wrapper });
    renderHook(() => useWeldPanelPublicResult('', {}), { wrapper });
    renderHook(() => useWeldPanelPublicResult('wpsh_abc', {}, false), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a link that is gone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Gone' } }), { status: 404 }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWeldPanelPublicShare('wpsh_gone'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

interface MutationCase {
  name: string;
  fn: Mock;
  answer: unknown;
  /** Renders the hook and hands back the call to make. */
  use: () => () => Promise<unknown>;
  args: unknown[];
  invalidates: (readonly unknown[])[];
  removes?: (readonly unknown[])[];
  /** What the mutation resolves to, when it hands something back. */
  resolves?: unknown;
}

const comment = { id: 'pncm_1', targetType: 'dashboard', targetId: 'wpd_1', body: 'Edited' };

const mutationCases: MutationCase[] = [
  {
    name: 'creating an annotation',
    fn: api.weldpanelCollab.annotations.create,
    answer: { data: { id: 'pnan_1' } },
    use: () => {
      const m = useCreateWeldPanelAnnotation();
      return () => m.mutateAsync({ projectId: 'wpp_1', occurredAt: '2026-11-01T12:00:00.000Z', label: 'Launch' });
    },
    args: [{ projectId: 'wpp_1', occurredAt: '2026-11-01T12:00:00.000Z', label: 'Launch' }],
    invalidates: [weldpanelCollabKeys.annotations()],
    resolves: { id: 'pnan_1' },
  },
  {
    name: 'updating an annotation',
    fn: api.weldpanelCollab.annotations.update,
    answer: { data: { id: 'pnan_1' } },
    use: () => {
      const m = useUpdateWeldPanelAnnotation();
      return () => m.mutateAsync({ id: 'pnan_1', label: 'Relaunch' });
    },
    args: ['pnan_1', { label: 'Relaunch' }],
    invalidates: [weldpanelCollabKeys.annotations()],
  },
  {
    name: 'deleting an annotation',
    fn: api.weldpanelCollab.annotations.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelAnnotation();
      return () => m.mutateAsync('pnan_1');
    },
    args: ['pnan_1'],
    invalidates: [weldpanelCollabKeys.annotations()],
  },
  {
    name: 'editing a comment',
    fn: api.weldpanelCollab.comments.update,
    answer: { data: comment },
    use: () => {
      const m = useUpdateWeldPanelComment();
      return () => m.mutateAsync({ id: 'pncm_1', body: 'Edited' });
    },
    args: ['pncm_1', { body: 'Edited' }],
    invalidates: [weldpanelCollabKeys.commentList(dashboard)],
    resolves: comment,
  },
  {
    name: 'deleting a comment',
    fn: api.weldpanelCollab.comments.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelComment(report);
      return () => m.mutateAsync('pncm_1');
    },
    args: ['pncm_1'],
    invalidates: [weldpanelCollabKeys.commentList(report)],
  },
  {
    name: 'revoking a share link',
    fn: api.weldpanelCollab.shareLinks.revoke,
    answer: undefined,
    use: () => {
      const m = useRevokeWeldPanelShareLink(dashboard);
      return () => m.mutateAsync('pnsl_1');
    },
    args: ['pnsl_1'],
    invalidates: [weldpanelCollabKeys.shareLinkList(dashboard)],
  },
  {
    name: 'creating a dashboard from a template',
    fn: api.weldpanel.dashboards.createFromTemplate,
    answer: { data: { id: 'wpd_9', name: 'Website overview' } },
    use: () => {
      const m = useCreateWeldPanelDashboardFromTemplate();
      return () => m.mutateAsync({ projectId: 'wpp_1', template: 'website-overview' });
    },
    args: [{ projectId: 'wpp_1', template: 'website-overview' }],
    invalidates: [
      [...weldpanelKeys.dashboards(), 'list'],
      [...weldpanelKeys.reports(), 'list'],
    ],
  },
  {
    name: 'creating an alert',
    fn: api.weldpanelMonitor.alerts.create,
    answer: { data: { id: 'pnal_1' } },
    use: () => {
      const m = useCreateWeldPanelAlert();
      return () => m.mutateAsync({ projectId: 'wpp_1', name: 'Drop', reportId: 'wpr_1', condition: { type: 'anomaly', sensitivity: 'high' }, channels });
    },
    args: [{ projectId: 'wpp_1', name: 'Drop', reportId: 'wpr_1', condition: { type: 'anomaly', sensitivity: 'high' }, channels }],
    invalidates: [weldpanelCollabKeys.alerts()],
    resolves: { id: 'pnal_1' },
  },
  {
    name: 'updating an alert',
    fn: api.weldpanelMonitor.alerts.update,
    answer: { data: { id: 'pnal_1' } },
    use: () => {
      const m = useUpdateWeldPanelAlert();
      return () => m.mutateAsync({ id: 'pnal_1', enabled: false });
    },
    args: ['pnal_1', { enabled: false }],
    invalidates: [weldpanelCollabKeys.alerts()],
  },
  {
    name: 'deleting an alert',
    fn: api.weldpanelMonitor.alerts.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelAlert();
      return () => m.mutateAsync('pnal_1');
    },
    args: ['pnal_1'],
    invalidates: [weldpanelCollabKeys.alerts()],
    removes: [weldpanelCollabKeys.alert('pnal_1')],
  },
  {
    name: 'testing an alert',
    fn: api.weldpanelMonitor.alerts.test,
    answer: { data: { delivered: [{ channel: 'email', ok: true, recipients: 1 }] } },
    use: () => {
      const m = useTestWeldPanelAlert();
      return () => m.mutateAsync('pnal_1');
    },
    args: ['pnal_1'],
    invalidates: [],
    resolves: { delivered: [{ channel: 'email', ok: true, recipients: 1 }] },
  },
  {
    name: 'snoozing an alert',
    fn: api.weldpanelMonitor.alerts.snooze,
    answer: { data: { id: 'pnal_1' } },
    use: () => {
      const m = useSnoozeWeldPanelAlert();
      return () => m.mutateAsync({ id: 'pnal_1', until: '2026-11-20T00:00:00.000Z' });
    },
    args: ['pnal_1', { until: '2026-11-20T00:00:00.000Z' }],
    invalidates: [weldpanelCollabKeys.alerts()],
  },
  {
    name: 'creating a scheduled report',
    fn: api.weldpanelMonitor.subscriptions.create,
    answer: { data: { id: 'pnsb_1' } },
    use: () => {
      const m = useCreateWeldPanelSubscription();
      return () =>
        m.mutateAsync({ projectId: 'wpp_1', name: 'Daily', targetType: 'report', targetId: 'wpr_1', schedule: { frequency: 'daily', hour: 8, timezone: 'UTC' }, channels });
    },
    args: [{ projectId: 'wpp_1', name: 'Daily', targetType: 'report', targetId: 'wpr_1', schedule: { frequency: 'daily', hour: 8, timezone: 'UTC' }, channels }],
    invalidates: [weldpanelCollabKeys.subscriptions()],
  },
  {
    name: 'updating a scheduled report',
    fn: api.weldpanelMonitor.subscriptions.update,
    answer: { data: { id: 'pnsb_1' } },
    use: () => {
      const m = useUpdateWeldPanelSubscription();
      return () => m.mutateAsync({ id: 'pnsb_1', name: 'Weekly' });
    },
    args: ['pnsb_1', { name: 'Weekly' }],
    invalidates: [weldpanelCollabKeys.subscriptions()],
  },
  {
    name: 'deleting a scheduled report',
    fn: api.weldpanelMonitor.subscriptions.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelSubscription();
      return () => m.mutateAsync('pnsb_1');
    },
    args: ['pnsb_1'],
    invalidates: [weldpanelCollabKeys.subscriptions()],
  },
  {
    name: 'sending a scheduled report now',
    fn: api.weldpanelMonitor.subscriptions.sendNow,
    answer: { data: { delivered: [] } },
    use: () => {
      const m = useSendWeldPanelSubscriptionNow();
      return () => m.mutateAsync('pnsb_1');
    },
    args: ['pnsb_1'],
    invalidates: [weldpanelCollabKeys.subscriptions()],
    resolves: { delivered: [] },
  },
  {
    name: 'creating a raw export',
    fn: api.weldpanelMonitor.exports.create,
    answer: { data: { id: 'pnex_1' } },
    use: () => {
      const m = useCreateWeldPanelExport();
      return () => m.mutateAsync({ projectId: 'wpp_1', name: 'Lake', destination, secretAccessKey: 's3cret', tables: ['events'] });
    },
    args: [{ projectId: 'wpp_1', name: 'Lake', destination, secretAccessKey: 's3cret', tables: ['events'] }],
    invalidates: [weldpanelCollabKeys.exports()],
  },
  {
    name: 'updating a raw export',
    fn: api.weldpanelMonitor.exports.update,
    answer: { data: { id: 'pnex_1' } },
    use: () => {
      const m = useUpdateWeldPanelExport();
      return () => m.mutateAsync({ id: 'pnex_1', frequency: 'hourly' });
    },
    args: ['pnex_1', { frequency: 'hourly' }],
    invalidates: [weldpanelCollabKeys.exports()],
  },
  {
    name: 'deleting a raw export',
    fn: api.weldpanelMonitor.exports.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelExport();
      return () => m.mutateAsync('pnex_1');
    },
    args: ['pnex_1'],
    invalidates: [weldpanelCollabKeys.exports()],
  },
  {
    name: 'resuming a raw export',
    fn: api.weldpanelMonitor.exports.resume,
    answer: { data: { id: 'pnex_1', status: 'active' } },
    use: () => {
      const m = usePauseWeldPanelExport();
      return () => m.mutateAsync({ id: 'pnex_1', pause: false });
    },
    args: ['pnex_1'],
    invalidates: [weldpanelCollabKeys.exports()],
  },
  {
    name: 'testing an export destination',
    fn: api.weldpanelMonitor.exports.test,
    answer: { data: { ok: true } },
    use: () => {
      const m = useTestWeldPanelExport();
      return () => m.mutateAsync({ exportId: 'pnex_1' });
    },
    args: [{ exportId: 'pnex_1' }],
    invalidates: [],
    resolves: { ok: true },
  },
  {
    name: 'adding a collector domain',
    fn: api.weldpanelMonitor.domains.create,
    answer: { data: { id: 'pndm_1' } },
    use: () => {
      const m = useCreateWeldPanelDomain('wpp_1');
      return () => m.mutateAsync('t.example.com');
    },
    args: ['wpp_1', { hostname: 't.example.com' }],
    invalidates: [weldpanelCollabKeys.domains('wpp_1')],
  },
  {
    name: 'checking a collector domain again',
    fn: api.weldpanelMonitor.domains.refresh,
    answer: { data: { id: 'pndm_1' } },
    use: () => {
      const m = useRefreshWeldPanelDomain('wpp_1');
      return () => m.mutateAsync('pndm_1');
    },
    args: ['wpp_1', 'pndm_1'],
    invalidates: [weldpanelCollabKeys.domains('wpp_1')],
  },
  {
    name: 'deleting a collector domain',
    fn: api.weldpanelMonitor.domains.remove,
    answer: undefined,
    use: () => {
      const m = useDeleteWeldPanelDomain('wpp_1');
      return () => m.mutateAsync('pndm_1');
    },
    args: ['wpp_1', 'pndm_1'],
    invalidates: [weldpanelCollabKeys.domains('wpp_1')],
  },
];

describe('mutations', () => {
  it.each(mutationCases)('$name: calls the client and refreshes what it changed', async ({ fn, answer, use, args, invalidates, removes, resolves }) => {
    fn.mockResolvedValue(answer);
    const { wrapper, invalidated, removed } = setup();
    const { result } = renderHook(use, { wrapper });
    let value: unknown;
    await act(async () => {
      value = await result.current();
    });
    expect(fn).toHaveBeenCalledWith(...args);
    expect(invalidated()).toEqual(invalidates);
    if (removes) expect(removed()).toEqual(removes);
    if (resolves !== undefined) expect(value).toEqual(resolves);
  });

  it('puts a dashboard made from a template in the cache', async () => {
    api.weldpanel.dashboards.createFromTemplate.mockResolvedValue({ data: { id: 'wpd_9', name: 'Website overview' } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useCreateWeldPanelDashboardFromTemplate(), { wrapper });
    await act(() => result.current.mutateAsync({ projectId: 'wpp_1', template: 'website-overview', locale: 'nl' }));
    expect(client.getQueryData(weldpanelKeys.dashboard('wpd_9'))).toEqual({ data: { id: 'wpd_9', name: 'Website overview' } });
  });

  it('refreshes nothing when the client fails', async () => {
    api.weldpanelMonitor.alerts.create.mockRejectedValue(new Error('nope'));
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelAlert(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ projectId: 'wpp_1', name: 'Drop', reportId: 'wpr_1', condition: { type: 'threshold', operator: 'below', value: 1 }, channels }),
      ).rejects.toThrow('nope');
    });
    expect(invalidated()).toEqual([]);
  });
});
