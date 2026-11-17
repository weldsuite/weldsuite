import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  weldpanel: { dashboards: { templates: vi.fn(), createFromTemplate: vi.fn(), updateTile: vi.fn() } },
  weldpanelCollab: {
    annotations: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    comments: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    reportVersions: { list: vi.fn(), get: vi.fn(), restore: vi.fn() },
    shareLinks: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
  },
  weldpanelMonitor: {
    alerts: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), events: vi.fn(), test: vi.fn(), snooze: vi.fn() },
    subscriptions: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), sendNow: vi.fn() },
    exports: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), runs: vi.fn(), pause: vi.fn(), resume: vi.fn(), test: vi.fn() },
    domains: { list: vi.fn(), create: vi.fn(), refresh: vi.fn(), remove: vi.fn() },
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@/lib/api/public-env', () => ({ getApiOriginForPath: () => 'https://panel-api.test' }));

import { weldpanelKeys } from './use-weldpanel-queries';
import {
  useCreateWeldPanelComment,
  useCreateWeldPanelShareLink,
  usePauseWeldPanelExport,
  useRestoreWeldPanelReportVersion,
  useUpdateWeldPanelTextTile,
  useWeldPanelAnnotations,
  useWeldPanelDomains,
  useWeldPanelPublicShare,
  weldpanelCollabKeys,
} from './use-weldpanel-collab-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated };
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const group of [api.weldpanel.dashboards, ...Object.values(api.weldpanelCollab), ...Object.values(api.weldpanelMonitor)]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
});

describe('keys', () => {
  it('hang under the module root, report history under its report and domains under their project', () => {
    expect(weldpanelCollabKeys.alerts().slice(0, 1)).toEqual(weldpanelKeys.all);
    expect(weldpanelCollabKeys.reportVersions('wpr_1').slice(0, weldpanelKeys.report('wpr_1').length)).toEqual(weldpanelKeys.report('wpr_1'));
    expect(weldpanelCollabKeys.domains('wpp_1').slice(0, weldpanelKeys.project('wpp_1').length)).toEqual(weldpanelKeys.project('wpp_1'));
  });
});

describe('queries', () => {
  it('lists annotations for a range and skips without a project', async () => {
    api.weldpanelCollab.annotations.list.mockResolvedValue({ data: [{ id: 'pnan_1' }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelAnnotations({ projectId: 'wpp_1', from: 'a', to: 'b' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'pnan_1' }]));
    expect(api.weldpanelCollab.annotations.list).toHaveBeenCalledWith({ projectId: 'wpp_1', from: 'a', to: 'b' });
    renderHook(() => useWeldPanelAnnotations({ projectId: '' }), { wrapper });
    expect(api.weldpanelCollab.annotations.list).toHaveBeenCalledTimes(1);
  });

  it('does not retry the domains when the feature is off', async () => {
    api.weldpanelMonitor.domains.list.mockRejectedValue(Object.assign(new Error('off'), { status: 503 }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelDomains('wpp_1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.weldpanelMonitor.domains.list).toHaveBeenCalledTimes(1);
  });

  it('reads a share link without a session, from the panel origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { name: 'Traffic' } }), { status: 200 }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelPublicShare('wpsh_abc'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Traffic' }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://panel-api.test/public/panel/share/wpsh_abc');
    expect((init as RequestInit).credentials).toBe('omit');
  });
});

describe('mutations', () => {
  it('refreshes the comments of the target a comment was posted on', async () => {
    api.weldpanelCollab.comments.create.mockResolvedValue({ data: { id: 'pncm_1', targetType: 'report', targetId: 'wpr_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelComment(), { wrapper });
    await result.current.mutateAsync({ targetType: 'report', targetId: 'wpr_1', body: 'Nice' });
    expect(invalidated()).toContainEqual(weldpanelCollabKeys.commentList({ targetType: 'report', targetId: 'wpr_1' }));
  });

  it('puts a restored report in the cache and refreshes its history and the dashboards', async () => {
    api.weldpanelCollab.reportVersions.restore.mockResolvedValue({ data: { id: 'wpr_1', name: 'Old name' } });
    const { client, wrapper, invalidated } = setup();
    const { result } = renderHook(() => useRestoreWeldPanelReportVersion('wpr_1'), { wrapper });
    await result.current.mutateAsync(2);
    expect(api.weldpanelCollab.reportVersions.restore).toHaveBeenCalledWith('wpr_1', 2);
    expect(client.getQueryData(weldpanelKeys.report('wpr_1'))).toEqual({ data: { id: 'wpr_1', name: 'Old name' } });
    expect(invalidated()).toContainEqual(weldpanelCollabKeys.reportVersions('wpr_1'));
    expect(invalidated()).toContainEqual(weldpanelKeys.dashboards());
  });

  it('refreshes the links of the shared object', async () => {
    api.weldpanelCollab.shareLinks.create.mockResolvedValue({ data: { id: 'pnsl_1', targetType: 'dashboard', targetId: 'wpd_1', token: 't', url: 'u' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelShareLink(), { wrapper });
    await result.current.mutateAsync({ targetType: 'dashboard', targetId: 'wpd_1' });
    expect(invalidated()).toContainEqual(weldpanelCollabKeys.shareLinkList({ targetType: 'dashboard', targetId: 'wpd_1' }));
  });

  it('sends only the text when a text tile changes', async () => {
    api.weldpanel.dashboards.updateTile.mockResolvedValue({ data: {} });
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateWeldPanelTextTile('wpd_1'), { wrapper });
    await result.current.mutateAsync({ tileId: 'wpt_1', text: 'Hello' });
    expect(api.weldpanel.dashboards.updateTile).toHaveBeenCalledWith('wpd_1', 'wpt_1', { text: 'Hello' });
  });

  it('pauses or resumes an export', async () => {
    api.weldpanelMonitor.exports.pause.mockResolvedValue({ data: {} });
    api.weldpanelMonitor.exports.resume.mockResolvedValue({ data: {} });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePauseWeldPanelExport(), { wrapper });
    await result.current.mutateAsync({ id: 'pnex_1', pause: true });
    await result.current.mutateAsync({ id: 'pnex_1', pause: false });
    expect(api.weldpanelMonitor.exports.pause).toHaveBeenCalledWith('pnex_1');
    expect(api.weldpanelMonitor.exports.resume).toHaveBeenCalledWith('pnex_1');
  });
});
