import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelDashboardDetailDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
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
  push: vi.fn(),
  select: vi.fn(),
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
vi.mock('../../components/report-view', () => ({ ReportView: ({ report }: { report: { name: string } }) => <div data-testid="report-view">{report.name} chart</div> }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelDashboard: () => ({ data: state.dashboard, isLoading: state.isLoading, isError: state.error !== null, error: state.error, refetch: vi.fn() }),
  useWeldPanelReports: () => ({ data: state.reports }),
  useUpdateWeldPanelDashboard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteWeldPanelDashboard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: state.addTile, isPending: false }),
  useRemoveWeldPanelDashboardTile: () => ({ mutateAsync: state.removeTile, isPending: false }),
  useSetWeldPanelDashboardLayout: () => ({ mutateAsync: state.setLayout, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const td = en.weldpanel.analytics.dashboards;

function withTiles(): PanelDashboardDetailDto {
  return makeDashboard({
    reports: [makeReport({ id: 'wpr_1', name: 'Signups' }), makeReport({ id: 'wpr_2', name: 'Pageviews' })],
    tiles: [
      { id: 'wpt_1', dashboardId: 'wpd_1', reportId: 'wpr_1', layout: { x: 0, y: 0, w: 12, h: 8 }, createdAt: '2026-11-01T09:00:00.000Z' },
      { id: 'wpt_2', dashboardId: 'wpd_1', reportId: 'wpr_2', layout: { x: 12, y: 0, w: 12, h: 8 }, createdAt: '2026-11-01T09:00:00.000Z' },
    ],
  });
}

async function openTileMenu(name: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: td.tile.actions.replace('{name}', name) }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Dashboard', () => {
  beforeEach(() => {
    state.canEdit = true;
    state.dashboard = withTiles();
    state.error = null;
    state.isLoading = false;
    state.reports = [];
    state.setLayout.mockReset();
    state.removeTile.mockReset();
    state.addTile.mockReset();
    state.push.mockReset();
    state.select.mockReset();
  });

  it('draws a tile per report, in reading order', () => {
    render(<DashboardDetailPage />);
    expect(screen.getByRole('heading', { name: 'Marketing weekly' })).toBeTruthy();
    const views = screen.getAllByTestId('report-view').map((el) => el.textContent);
    expect(views).toEqual(['Signups chart', 'Pageviews chart']);
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

  it('makes a tile taller', async () => {
    state.setLayout.mockResolvedValue(undefined);
    render(<DashboardDetailPage />);
    await openTileMenu('Pageviews', td.tile.taller);
    await waitFor(() => expect(state.setLayout).toHaveBeenCalledTimes(1));
    const tiles = state.setLayout.mock.calls[0]?.[0].tiles as { id: string; layout: { h: number } }[];
    expect(tiles.find((t) => t.id === 'wpt_2')?.layout.h).toBeGreaterThan(8);
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
    await userEvent.click(screen.getByRole('button', { name: td.addReport }));
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
    expect(screen.queryByRole('button', { name: td.addReport })).toBeNull();
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
