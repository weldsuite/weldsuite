import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelDashboardDetailDto, PanelDashboardDetailTileDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { makeDashboard, makeReport } from '../../analytics-fixtures';
import DashboardDetailPage from './page';

const state = vi.hoisted(() => ({
  canEdit: true,
  dashboard: undefined as unknown,
  error: null as unknown,
  isLoading: false,
  reports: [] as unknown[],
  setLayout: vi.fn(),
  removeTile: vi.fn(),
  addTile: vi.fn(),
  update: vi.fn(),
  updateText: vi.fn(),
  push: vi.fn(),
  select: vi.fn(),
  viewSpecs: [] as unknown[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canEdit }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  useParams: () => ({ dashboardId: 'wpd_1' }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../lib/use-current-project', () => ({ useCurrentProject: () => ({ select: state.select }) }));
vi.mock('../../components/report-view', () => ({
  parseReportSpec: () => null,
  ReportView: ({ report, spec }: { report: { name: string }; spec?: unknown }) => {
    state.viewSpecs.push(spec);
    return <div data-testid="report-view">{report.name} chart</div>;
  },
}));
// The real builder reads the lexicon; here it adds one fixed filter.
vi.mock('../../components/filter-builder', () => ({
  FilterBuilder: ({ onChange }: { onChange: (filters: unknown[]) => void }) => (
    <button type="button" onClick={() => onChange([{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }])}>
      add country filter
    </button>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelDashboard: () => ({ data: state.dashboard, isLoading: state.isLoading, isError: state.error !== null, error: state.error, refetch: vi.fn() }),
  useWeldPanelReports: () => ({ data: state.reports }),
  useWeldPanelQuery: () => ({ data: undefined }),
  useUpdateWeldPanelDashboard: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelDashboard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: state.addTile, isPending: false }),
  useRemoveWeldPanelDashboardTile: () => ({ mutateAsync: state.removeTile, isPending: false }),
  useSetWeldPanelDashboardLayout: () => ({ mutateAsync: state.setLayout, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useUpdateWeldPanelTextTile: () => ({ mutateAsync: state.updateText, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const td = en.weldpanel.analytics.dashboards;
const tcol = en.weldpanel.collab.dashboards;

function tile(overrides: Partial<PanelDashboardDetailTileDto>): PanelDashboardDetailTileDto {
  return { id: 'wpt_1', dashboardId: 'wpd_1', kind: 'report', reportId: 'wpr_1', text: null, spec: null, layout: { x: 0, y: 0, w: 12, h: 8 }, createdAt: '2026-11-01T09:00:00.000Z', ...overrides };
}

function withTiles(): PanelDashboardDetailDto {
  return makeDashboard({
    reports: [makeReport({ id: 'wpr_1', name: 'Signups' }), makeReport({ id: 'wpr_2', name: 'Pageviews' })],
    tiles: [tile({ id: 'wpt_1', reportId: 'wpr_1' }), tile({ id: 'wpt_2', reportId: 'wpr_2', layout: { x: 12, y: 0, w: 12, h: 8 } })],
  });
}

async function openTileMenu(name: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: td.tile.actions.replace('{name}', name) }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

async function openAddMenu(item: string) {
  await userEvent.click(screen.getByRole('button', { name: tcol.addMenu }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Dashboard', () => {
  beforeEach(() => {
    state.canEdit = true;
    state.dashboard = withTiles();
    state.error = null;
    state.isLoading = false;
    state.reports = [];
    state.viewSpecs = [];
    for (const fn of [state.setLayout, state.removeTile, state.addTile, state.update, state.updateText, state.push, state.select]) fn.mockReset();
  });

  it('draws a tile per report, in reading order', () => {
    render(<DashboardDetailPage />);
    expect(screen.getByRole('heading', { name: 'Marketing weekly' })).toBeTruthy();
    const views = screen.getAllByTestId('report-view').map((el) => el.textContent);
    expect(views).toEqual(['Signups chart', 'Pageviews chart']);
  });

  it('runs a tile with its own spec, which carries the dashboard filters', () => {
    const filtered = { kind: 'trends', dateRange: { preset: '7d' }, filters: [] };
    state.dashboard = makeDashboard({ reports: [makeReport({ id: 'wpr_1', name: 'Signups' })], tiles: [tile({ spec: filtered })] });
    render(<DashboardDetailPage />);
    expect(state.viewSpecs[state.viewSpecs.length - 1]).toEqual(filtered);
  });

  it('draws a text tile as Markdown and counts only report tiles', () => {
    state.dashboard = makeDashboard({
      reports: [makeReport({ id: 'wpr_1', name: 'Signups' })],
      tiles: [tile({ id: 'wpt_text', kind: 'text', reportId: null, text: '## Read me first\n\nSome **context**.' }), tile({ id: 'wpt_1', layout: { x: 12, y: 0, w: 12, h: 8 } })],
    });
    render(<DashboardDetailPage />);
    expect(screen.getByRole('heading', { name: 'Read me first' })).toBeTruthy();
    expect(screen.getByText(td.tileCount.replace('{count}', '1'))).toBeTruthy();
    expect(screen.getAllByTestId('report-view')).toHaveLength(1);
  });

  it('edits a text tile', async () => {
    state.updateText.mockResolvedValue(undefined);
    state.dashboard = makeDashboard({ tiles: [tile({ id: 'wpt_text', kind: 'text', reportId: null, text: 'Old' })] });
    render(<DashboardDetailPage />);
    await openTileMenu(tcol.text.label, tcol.text.edit);
    const dialog = await screen.findByRole('dialog', { name: tcol.text.editTitle });
    const box = within(dialog).getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, 'New text');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.updateText).toHaveBeenCalledWith({ tileId: 'wpt_text', text: 'New text' }));
  });

  it('adds a text tile', async () => {
    state.addTile.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openAddMenu(tcol.text.add);
    const dialog = await screen.findByRole('dialog', { name: tcol.text.addTitle });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Hello');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.add }));
    await waitFor(() => expect(state.addTile).toHaveBeenCalledTimes(1));
    expect(state.addTile.mock.calls[0]?.[0]).toMatchObject({ kind: 'text', text: 'Hello', layout: { x: 0, y: 1000 } });
  });

  it('saves dashboard filters', async () => {
    state.update.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    const bar = screen.getByTestId('weldpanel-dashboard-filters');
    await userEvent.click(within(bar).getByRole('button', { name: 'add country filter' }));
    await userEvent.click(within(bar).getByRole('button', { name: tcol.filters.apply }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toEqual({ filters: { filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] } });
  });

  it('clears dashboard filters', async () => {
    state.update.mockResolvedValue(undefined);
    state.dashboard = { ...withTiles(), filters: { dateRange: { preset: '7d' }, filters: [] } };
    render(<DashboardDetailPage />);
    await userEvent.click(within(screen.getByTestId('weldpanel-dashboard-filters')).getByRole('button', { name: tcol.filters.clear }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ filters: null }));
  });

  it('shows the filters read-only without the update permission', () => {
    state.canEdit = false;
    state.dashboard = { ...withTiles(), filters: { dateRange: { preset: '7d' }, filters: [] } };
    render(<DashboardDetailPage />);
    const bar = screen.getByTestId('weldpanel-dashboard-filters');
    expect(bar.textContent).toContain(en.weldpanel.analytics.range['7d']);
    expect(within(bar).queryByRole('button')).toBeNull();
  });

  it('switches the module to the dashboard\'s project', () => {
    render(<DashboardDetailPage />);
    expect(state.select).toHaveBeenCalledWith('wpp_1');
  });

  it('links a tile to its report', () => {
    render(<DashboardDetailPage />);
    expect(screen.getByRole('link', { name: 'Signups' }).getAttribute('href')).toBe('/weldpanel/insights?report=wpr_1');
  });

  it('moves a tile later and saves the packed layout', async () => {
    state.setLayout.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openTileMenu('Signups', td.tile.later);
    await waitFor(() => expect(state.setLayout).toHaveBeenCalledTimes(1));
    expect(state.setLayout.mock.calls[0]?.[0]).toEqual({
      tiles: [
        { id: 'wpt_2', layout: { x: 0, y: 0, w: 12, h: 8 } },
        { id: 'wpt_1', layout: { x: 12, y: 0, w: 12, h: 8 } },
      ],
    });
  });

  it('makes a tile wider, which pushes the next one to a new row', async () => {
    state.setLayout.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openTileMenu('Signups', td.tile.wider);
    await waitFor(() => expect(state.setLayout).toHaveBeenCalledTimes(1));
    expect(state.setLayout.mock.calls[0]?.[0]).toEqual({
      tiles: [
        { id: 'wpt_1', layout: { x: 0, y: 0, w: 16, h: 8 } },
        { id: 'wpt_2', layout: { x: 0, y: 8, w: 12, h: 8 } },
      ],
    });
  });

  it('removes a tile from the dashboard', async () => {
    state.removeTile.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openTileMenu('Signups', td.tile.remove);
    await waitFor(() => expect(state.removeTile).toHaveBeenCalledWith('wpt_1'));
  });

  it('adds a saved report that is not on the dashboard yet', async () => {
    state.reports = [makeReport({ id: 'wpr_1', name: 'Signups' }), makeReport({ id: 'wpr_3', name: 'Churn' })];
    state.addTile.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openAddMenu(tcol.addReport);
    const dialog = await screen.findByRole('dialog', { name: td.addTitle });
    await userEvent.click(within(dialog).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: /Signups/ })).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: /Churn/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.add }));
    await waitFor(() => expect(state.addTile).toHaveBeenCalledTimes(1));
    expect(state.addTile.mock.calls[0]?.[0]).toMatchObject({ reportId: 'wpr_3', layout: { x: 0, y: 1000 } });
  });

  it('shows an empty dashboard with a way to add a report', () => {
    state.dashboard = makeDashboard();
    render(<DashboardDetailPage />);
    expect(screen.getByText(td.emptyDashboardTitle)).toBeTruthy();
  });

  it('hides editing without the update permission', async () => {
    state.canEdit = false;
    render(<DashboardDetailPage />);
    expect(screen.queryByRole('button', { name: tcol.addMenu })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: td.tile.actions.replace('{name}', 'Signups') }));
    expect(await screen.findByRole('menuitem', { name: td.tile.openReport })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: td.tile.remove })).toBeNull();
  });

  it('says so when the dashboard does not exist', () => {
    state.dashboard = undefined;
    state.error = new ApiError('Not found', 404);
    render(<DashboardDetailPage />);
    expect(screen.getByText(td.notFound)).toBeTruthy();
  });
});
