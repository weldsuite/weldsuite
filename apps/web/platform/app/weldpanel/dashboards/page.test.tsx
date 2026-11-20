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
  createFromTemplate: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelDashboards: () => ({ data: state.isError ? undefined : state.dashboards, isLoading: false, isError: state.isError, refetch: vi.fn() }),
  useCreateWeldPanelDashboard: () => ({ mutateAsync: state.create, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldpanel-collab-queries', () => ({
  useWeldPanelDashboardTemplates: () => ({
    data: [
      {
        id: 'website-overview',
        name: 'Website overview',
        description: 'Traffic at a glance',
        tiles: [
          { kind: 'text', reportName: null, reportKind: null, text: 'Hi', layout: { x: 0, y: 0, w: 24, h: 3 } },
          { kind: 'report', reportName: 'Traffic', reportKind: 'web', text: null, layout: { x: 0, y: 3, w: 24, h: 8 } },
        ],
      },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useCreateWeldPanelDashboardFromTemplate: () => ({ mutateAsync: state.createFromTemplate, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const td = en.weldpanel.analytics.dashboards;
const tt = en.weldpanel.collab.dashboards.templates;

/** "New dashboard" offers the templates first; "Empty dashboard" opens the name form. */
async function openBlankForm() {
  await userEvent.click(screen.getAllByRole('button', { name: td.newDashboard })[0]!);
  const gallery = await screen.findByRole('dialog', { name: tt.title });
  await userEvent.click(within(gallery).getByRole('button', { name: new RegExp(tt.blank) }));
  return screen.findByRole('dialog', { name: td.createTitle });
}

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
    state.createFromTemplate.mockReset();
    state.push.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the dashboards as rows that open their page', async () => {
    render(<DashboardsPage />);
    expect(screen.getByText('Marketing weekly')).toBeTruthy();
    expect(screen.getByText('The numbers for Monday')).toBeTruthy();
    expect(screen.getByText(en.weldpanel.analytics.common.workspace)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.view }));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/dashboards/wpd_1');
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
    const dialog = await openBlankForm();
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.save.nameLabel), 'Sales');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.create }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ projectId: 'wpp_1', name: 'Sales', visibility: 'private' });
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/dashboards/wpd_new'));
  });

  it('needs a name', async () => {
    render(<DashboardsPage />);
    const dialog = await openBlankForm();
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.create }));
    expect(await screen.findByText(en.weldpanel.analytics.save.nameRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('creates a dashboard from a template and opens it', async () => {
    state.createFromTemplate.mockResolvedValue(dashboard({ id: 'wpd_tpl' }));
    render(<DashboardsPage />);
    await userEvent.click(screen.getByRole('button', { name: td.newDashboard }));
    const gallery = await screen.findByRole('dialog', { name: tt.title });
    await userEvent.click(within(gallery).getByRole('button', { name: /Website overview/ }));
    const form = await screen.findByRole('dialog', { name: 'Website overview' });
    expect(within(form).getByText('Traffic')).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: tt.use }));
    await waitFor(() => expect(state.createFromTemplate).toHaveBeenCalledTimes(1));
    expect(state.createFromTemplate.mock.calls[0]?.[0]).toMatchObject({ projectId: 'wpp_1', template: 'website-overview', name: 'Website overview', visibility: 'private', locale: 'en' });
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/dashboards/wpd_tpl'));
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
