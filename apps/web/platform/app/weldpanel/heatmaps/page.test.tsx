import { gzipSync } from 'node:zlib';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelHeatmapSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeHeatmap } from '../observe-fixtures';
import { makeProject } from '../test-fixtures';
import HeatmapsPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete', 'panel_recordings:read']),
  groups: { data: undefined as unknown, isLoading: false },
  heatmap: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  specs: [] as PanelHeatmapSpec[],
  snapshot: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  view: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('./snapshot-view', () => ({
  SnapshotView: (props: { deviceClass: string; heatmap: { type: string } }) => {
    state.view(props);
    return <div data-testid="snapshot-view">{props.deviceClass}/{props.heatmap.type}</div>;
  },
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  weldpanelKeys: { all: ['weldpanel'] },
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelHeatmapPages: () => state.groups,
  useWeldPanelHeatmap: (spec: PanelHeatmapSpec) => {
    state.specs.push(spec);
    return state.heatmap;
  },
  useWeldPanelHeatmapSnapshotLoader: () => state.snapshot,
  useCreateWeldPanelHeatmapPage: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelHeatmapPage: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelHeatmapPage: () => ({ mutateAsync: state.remove, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const th = en.weldpanel.observe.heatmaps;
const group = { id: 'wphp_1', projectId: 'wpp_1', name: 'Product pages', urlPattern: '/products/*', createdByUserId: 'u', createdAt: DATA_AS_OF, updatedAt: DATA_AS_OF };
const lastSpec = () => state.specs[state.specs.length - 1]!;
const snapshotResponse = () => {
  const bytes = gzipSync(Buffer.from(JSON.stringify({ type: 2, timestamp: 1, data: {} })));
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const heat = (result = makeHeatmap()) => ({ data: { kind: 'heatmap', result, dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HeatmapsPage />
    </QueryClientProvider>,
  );
}

describe('Heatmaps', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete', 'panel_recordings:read']);
    state.groups = { data: [group], isLoading: false };
    state.heatmap = heat();
    state.specs = [];
    state.snapshot.mockReset();
    state.snapshot.mockImplementation(async () => snapshotResponse());
    for (const fn of [state.create, state.update, state.remove, state.view, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('asks for the first page group, on desktop, as clicks', () => {
    renderPage();
    expect(lastSpec()).toMatchObject({ kind: 'heatmap', projectId: 'wpp_1', pageGroupId: 'wphp_1', deviceClass: 'desktop', type: 'click', dateRange: { preset: '30d' } });
  });

  it('draws the heat layer on the loaded snapshot', async () => {
    renderPage();
    expect(await screen.findByTestId('snapshot-view')).toBeTruthy();
    expect(screen.getByText('desktop/click')).toBeTruthy();
    expect(state.snapshot).toHaveBeenCalledWith('wphp_1', 'desktop');
    expect(screen.getByText('900')).toBeTruthy();
    expect(screen.getAllByText('150').length).toBeGreaterThan(0);
  });

  it('lists the most clicked elements for clicks and areas', () => {
    renderPage();
    expect(screen.getByText('Buy now')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText('.nav a')).toBeTruthy();
  });

  it('switches device and type, and fetches the snapshot for the new device', async () => {
    renderPage();
    await screen.findByTestId('snapshot-view');
    await userEvent.click(screen.getByRole('radio', { name: en.weldpanel.observe.common.devices.mobile }));
    expect(lastSpec().deviceClass).toBe('mobile');
    await userEvent.click(screen.getByRole('radio', { name: th.types.scroll }));
    expect(lastSpec().type).toBe('scroll');
    await waitFor(() => expect(state.snapshot).toHaveBeenCalledWith('wphp_1', 'mobile'));
  });

  it('says the background is on its way and still shows the numbers', async () => {
    state.snapshot.mockRejectedValue(new ApiError('Asked', 404, { error: { code: 'SNAPSHOT_REQUESTED' } }));
    renderPage();
    expect(await screen.findByText(th.snapshotRequestedTitle)).toBeTruthy();
    expect(screen.getByText('900')).toBeTruthy();
    expect(screen.queryByTestId('snapshot-view')).toBeNull();
  });

  it('says when no background can be had', async () => {
    state.snapshot.mockRejectedValue(new ApiError('None', 404, { error: { code: 'SNAPSHOT_UNAVAILABLE' } }));
    renderPage();
    expect(await screen.findByText(th.snapshotUnavailableTitle)).toBeTruthy();
  });

  it('reports a snapshot that failed to load for another reason', async () => {
    state.snapshot.mockRejectedValue(new ApiError('boom', 500));
    renderPage();
    expect(await screen.findByText(th.snapshotFailed)).toBeTruthy();
  });

  it('does not ask for a snapshot without the recordings permission', () => {
    state.perms = new Set(['panel_reports:create']);
    renderPage();
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(screen.getByText(en.weldpanel.observe.common.noPermission)).toBeTruthy();
  });

  it('shows an empty state when the group has no clicks', () => {
    state.heatmap = heat(makeHeatmap({ clicks: 0, elements: [], points: [] }));
    renderPage();
    expect(screen.getByText(th.noData)).toBeTruthy();
  });

  it('explains the scroll depth', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: th.types.scroll }));
    expect(screen.getByText('Half of the visitors stop reading at 50% of the page.')).toBeTruthy();
  });

  it('starts from an empty project with a way to make the first page group', async () => {
    state.groups = { data: [], isLoading: false };
    state.create.mockResolvedValue({ ...group, id: 'wphp_2' });
    renderPage();
    expect(screen.getByText(th.noGroupsTitle)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: th.newPageGroup }));
    await userEvent.type(screen.getByLabelText(th.dialog.name), 'Blog');
    await userEvent.type(screen.getByLabelText(th.dialog.pattern), '/blog/*');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ projectId: 'wpp_1', name: 'Blog', urlPattern: '/blog/*' }));
    expect(state.toast.success).toHaveBeenCalledWith(th.saved);
  });

  it('refuses a pattern that does not start with a slash', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: th.newPageGroup }));
    await userEvent.type(screen.getByLabelText(th.dialog.name), 'Blog');
    await userEvent.type(screen.getByLabelText(th.dialog.pattern), 'blog');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    expect(await screen.findByText(en.weldpanel.validation.patternInvalid)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('edits a page group', async () => {
    state.update.mockResolvedValue(group);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: th.editPageGroup }));
    const pattern = screen.getByLabelText(th.dialog.pattern);
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '/shop/*');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'wphp_1', name: 'Product pages', urlPattern: '/shop/*' }));
  });

  it('deletes a page group after a confirmation', async () => {
    state.remove.mockResolvedValue(undefined);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: th.deletePageGroup }));
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: th.deleteConfirm }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wphp_1'));
  });

  it('hides editing from people without the permissions', () => {
    state.perms = new Set(['panel_recordings:read']);
    renderPage();
    expect(screen.queryByRole('button', { name: th.newPageGroup })).toBeNull();
    expect(screen.queryByRole('button', { name: th.editPageGroup })).toBeNull();
    expect(screen.queryByRole('button', { name: th.deletePageGroup })).toBeNull();
  });
});
