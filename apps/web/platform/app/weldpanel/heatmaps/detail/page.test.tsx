import { gzipSync } from 'node:zlib';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelHeatmapSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF } from '../../analytics-fixtures';
import { resetCurrentProjectChoice } from '../../lib/use-current-project';
import { makeHeatmap } from '../../observe-fixtures';
import { makeProject } from '../../test-fixtures';
import HeatmapDetailPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete', 'panel_recordings:read']),
  groups: { data: undefined as unknown, isLoading: false },
  heatmap: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  specs: [] as PanelHeatmapSpec[],
  /** The right column's own questions (element areas, scroll depth). */
  sideSpecs: [] as PanelHeatmapSpec[],
  snapshot: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  view: vi.fn(),
  push: vi.fn(),
  pageId: 'wphp_1',
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
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  useParams: () => ({ pageId: state.pageId }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../snapshot-view', () => ({
  SnapshotView: (props: { deviceClass: string; heatmap: { type: string } }) => {
    state.view(props);
    return <div data-testid="snapshot-view">{props.deviceClass}/{props.heatmap.type}</div>;
  },
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  weldpanelKeys: { all: ['weldpanel'] },
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelHeatmapPages: () => state.groups,
  // The heat layer asks without options; the right column's tabs pass `enabled`.
  useWeldPanelHeatmap: (spec: PanelHeatmapSpec, options?: { enabled?: boolean }) => {
    (options ? state.sideSpecs : state.specs).push(spec);
    return state.heatmap;
  },
  useWeldPanelHeatmapSnapshotLoader: () => state.snapshot,
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

/** Opens a filter pill's value (shown as `current`) and picks `next` in its list (rendered last, in a portal). */
async function pick(current: string, next: string) {
  await userEvent.click(screen.getByRole('button', { name: current }));
  const matches = await screen.findAllByText(next, { selector: 'button, button *, [role="option"], [role="option"] *, [role="menuitem"], [role="menuitem"] *' });
  await userEvent.click(matches[matches.length - 1]!);
}

/** Opens the ⋮ menu and picks an item. */
async function menu(item: string) {
  await userEvent.click(screen.getByRole('button', { name: en.common.actions.title }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {/* The Info tab's rows read their labels through the shared provider. */}
      <I18nProvider initialLanguage="en">
        <HeatmapDetailPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('A page group heatmap', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete', 'panel_recordings:read']);
    state.groups = { data: [group], isLoading: false };
    state.pageId = 'wphp_1';
    state.heatmap = heat();
    state.specs = [];
    state.sideSpecs = [];
    state.snapshot.mockReset();
    state.snapshot.mockImplementation(async () => snapshotResponse());
    for (const fn of [state.create, state.update, state.remove, state.view, state.push, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('names the page group and its pattern, and asks for it on desktop, as clicks', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Product pages' })).toBeTruthy();
    expect(screen.getByText('/products/*')).toBeTruthy();
    expect(lastSpec()).toMatchObject({ kind: 'heatmap', projectId: 'wpp_1', pageGroupId: 'wphp_1', deviceClass: 'desktop', type: 'click', dateRange: { preset: '30d' } });
  });

  it('draws the heat layer on the loaded snapshot', async () => {
    renderPage();
    expect(await screen.findByTestId('snapshot-view')).toBeTruthy();
    expect(screen.getByText('desktop/click')).toBeTruthy();
    expect(state.snapshot).toHaveBeenCalledWith('wphp_1', 'desktop');
  });

  it('ranks the clicked elements in the Elements tab, asking for click areas', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: th.tabs.elements, selected: true })).toBeTruthy();
    expect(state.sideSpecs.some((spec) => spec.type === 'area')).toBe(true);
    expect(screen.getByText('Buy now')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText('.nav a')).toBeTruthy();
  });

  it('shows how far visitors scroll in the Scroll depth tab', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: th.tabs.scroll }));
    expect(state.sideSpecs.some((spec) => spec.type === 'scroll')).toBe(true);
    expect(await screen.findByText(th.depthCol)).toBeTruthy();
    expect(screen.getByText(th.reachedCol)).toBeTruthy();
  });

  it('shows the page group and the figures in the Info tab', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: th.tabs.info }));
    expect(await screen.findByText(th.info.pageGroup)).toBeTruthy();
    expect(screen.getAllByText('/products/*').length).toBeGreaterThan(0);
    expect(screen.getByText(th.info.heatmap)).toBeTruthy();
    // The figures live here now, not above the page.
    expect(screen.getByText('900')).toBeTruthy();
    expect(screen.getByText(th.stats.unresolved)).toBeTruthy();
  });

  it('switches device and type with the filter pills, and fetches the snapshot for the new device', async () => {
    renderPage();
    await screen.findByTestId('snapshot-view');
    await pick(en.weldpanel.observe.common.devices.desktop, en.weldpanel.observe.common.devices.mobile);
    expect(lastSpec().deviceClass).toBe('mobile');
    await pick(th.types.click, th.types.scroll);
    expect(lastSpec().type).toBe('scroll');
    await waitFor(() => expect(state.snapshot).toHaveBeenCalledWith('wphp_1', 'mobile'));
  });

  it('finds an element in the Elements tab', async () => {
    renderPage();
    await userEvent.type(screen.getAllByPlaceholderText(th.searchElements)[0]!, 'nav');
    await waitFor(() => expect(screen.queryByText('Buy now')).toBeNull());
    expect(screen.getByText('.nav a')).toBeTruthy();
  });

  it('says the background is on its way', async () => {
    state.snapshot.mockRejectedValue(new ApiError('Asked', 404, { error: { code: 'SNAPSHOT_REQUESTED' } }));
    renderPage();
    expect(await screen.findByText(th.snapshotRequestedTitle)).toBeTruthy();
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

  it('explains the scroll depth in the Scroll depth tab', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: th.tabs.scroll }));
    expect(await screen.findByText('Half of the visitors stop reading at 50% of the page.')).toBeTruthy();
  });

  it('shows the page alone, without a title or notes around it', () => {
    renderPage();
    expect(screen.queryByText(th.layer)).toBeNull();
    expect(screen.queryByText(th.typeHints.click)).toBeNull();
  });

  it('edits a page group from the menu', async () => {
    state.update.mockResolvedValue(group);
    renderPage();
    await menu(th.editPageGroup);
    const pattern = screen.getByLabelText(th.dialog.pattern);
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '/shop/*');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'wphp_1', name: 'Product pages', urlPattern: '/shop/*' }));
  });

  it('deletes a page group from the menu after a confirmation', async () => {
    state.remove.mockResolvedValue(undefined);
    renderPage();
    await menu(th.deletePageGroup);
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: th.deleteConfirm }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wphp_1'));
  });

  it('goes back to the list', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: th.back }));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/heatmaps');
  });

  it('goes back to the list after deleting the page group', async () => {
    state.remove.mockResolvedValue(undefined);
    renderPage();
    await menu(th.deletePageGroup);
    await userEvent.click(screen.getByRole('button', { name: th.deleteConfirm }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/heatmaps'));
  });

  it('says when the page group no longer exists', () => {
    state.pageId = 'wphp_gone';
    renderPage();
    expect(screen.getByText(th.notFound)).toBeTruthy();
    expect(state.specs).toHaveLength(0);
  });

  it('hides editing from people without the permissions', () => {
    state.perms = new Set(['panel_recordings:read']);
    renderPage();
    expect(screen.queryByRole('button', { name: en.common.actions.title })).toBeNull();
  });
});
