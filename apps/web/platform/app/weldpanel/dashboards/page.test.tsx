import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import DashboardsPage from './page';

const state = vi.hoisted(() => ({
  canCreate: true,
  dashboards: [] as unknown[],
  isError: false,
  create: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelDashboards: () => ({ data: state.isError ? undefined : state.dashboards, isLoading: false, isError: state.isError, refetch: vi.fn() }),
  useCreateWeldPanelDashboard: () => ({ mutateAsync: state.create, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const td = en.weldpanel.analytics.dashboards;

const dashboard = (overrides: Record<string, unknown> = {}) => ({
  id: 'wpd_1',
  projectId: 'wpp_1',
  name: 'Marketing weekly',
  description: 'The numbers for Monday',
  ownerUserId: 'user_1',
  visibility: 'workspace',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
  ...overrides,
});

describe('Dashboards', () => {
  beforeEach(() => {
    state.canCreate = true;
    state.dashboards = [dashboard()];
    state.isError = false;
    state.create.mockReset();
    state.push.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the dashboards as links to their page', () => {
    render(<DashboardsPage />);
    const link = screen.getByRole('link', { name: /Marketing weekly/ });
    expect(link.getAttribute('href')).toBe('/weldpanel/dashboards/wpd_1');
    expect(within(link).getByText('The numbers for Monday')).toBeTruthy();
  });

  it('shows an empty state that offers to create the first one', async () => {
    state.dashboards = [];
    render(<DashboardsPage />);
    expect(screen.getByText(td.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: td.newDashboard })).toHaveLength(2);
  });

  it('creates a dashboard and opens it', async () => {
    state.create.mockResolvedValue(dashboard({ id: 'wpd_new' }));
    render(<DashboardsPage />);
    await userEvent.click(screen.getByRole('button', { name: td.newDashboard }));
    const dialog = await screen.findByRole('dialog', { name: td.createTitle });
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.save.nameLabel), 'Sales');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.create }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ projectId: 'wpp_1', name: 'Sales', visibility: 'private' });
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/dashboards/wpd_new'));
  });

  it('needs a name', async () => {
    render(<DashboardsPage />);
    await userEvent.click(screen.getByRole('button', { name: td.newDashboard }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.create }));
    expect(await screen.findByText(en.weldpanel.analytics.save.nameRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('has no create button without the permission', () => {
    state.canCreate = false;
    render(<DashboardsPage />);
    expect(screen.queryByRole('button', { name: td.newDashboard })).toBeNull();
  });

  it('shows an error state when the list fails', () => {
    state.isError = true;
    render(<DashboardsPage />);
    expect(screen.getByText(td.loadFailed)).toBeTruthy();
  });
});
