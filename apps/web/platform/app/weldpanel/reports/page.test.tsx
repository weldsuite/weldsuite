import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeReport } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import ReportsPage from './page';

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  reports: [] as unknown[],
  isLoading: false,
  isError: false,
  params: [] as unknown[],
  update: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelReports: (params: unknown) => {
    state.params.push(params);
    return { data: state.isError ? undefined : state.reports, isLoading: state.isLoading, isError: state.isError, refetch: state.refetch };
  },
  useUpdateWeldPanelReport: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelReport: () => ({ mutateAsync: state.remove, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tr = en.weldpanel.analytics.reports;
const lastParams = () => state.params[state.params.length - 1];

describe('Reports', () => {
  beforeEach(() => {
    state.allowed = new Set(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete']);
    state.reports = [
      makeReport({ id: 'wpr_1', name: 'Weekly signups', visibility: 'workspace' }),
      makeReport({ id: 'wpr_2', name: 'Checkout funnel', kind: 'funnel', description: 'Cart to paid' }),
    ];
    state.isLoading = false;
    state.isError = false;
    state.params = [];
    state.update.mockReset();
    state.remove.mockReset();
    state.refetch.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the reports of the project with their type and visibility', () => {
    render(<ReportsPage />);
    expect(lastParams()).toEqual({ projectId: 'wpp_1', scope: 'all' });
    expect(screen.getByText('Weekly signups')).toBeTruthy();
    expect(screen.getByText('Cart to paid')).toBeTruthy();
    expect(screen.getByText(en.weldpanel.analytics.kinds.funnel)).toBeTruthy();
    expect(screen.getByText(en.weldpanel.analytics.common.workspace)).toBeTruthy();
  });

  it('opens a report in the builder of its kind', () => {
    render(<ReportsPage />);
    expect(screen.getByRole('link', { name: 'Checkout funnel' }).getAttribute('href')).toBe('/weldpanel/funnels?report=wpr_2');
    expect(screen.getByRole('link', { name: 'Weekly signups' }).getAttribute('href')).toBe('/weldpanel/insights?report=wpr_1');
  });

  it('filters by scope and type', async () => {
    render(<ReportsPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tr.scopeLabel }));
    await userEvent.click(await screen.findByRole('option', { name: tr.scopes.mine }));
    expect(lastParams()).toEqual({ projectId: 'wpp_1', scope: 'mine' });
    await userEvent.click(screen.getByRole('combobox', { name: tr.kindLabel }));
    await userEvent.click(await screen.findByRole('option', { name: en.weldpanel.analytics.kinds.retention }));
    expect(lastParams()).toEqual({ projectId: 'wpp_1', scope: 'mine', kind: 'retention' });
  });

  it('starts a new report in the right builder', async () => {
    render(<ReportsPage />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(tr.newReport) }));
    expect((await screen.findByRole('menuitem', { name: tr.newKinds.retention })).getAttribute('href')).toBe('/weldpanel/retention');
  });

  it('renames a report', async () => {
    state.update.mockResolvedValue(makeReport());
    render(<ReportsPage />);
    await userEvent.click(screen.getByRole('button', { name: tr.actions.replace('{name}', 'Weekly signups') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.rename }));
    const dialog = await screen.findByRole('dialog', { name: tr.renameTitle });
    const input = within(dialog).getByLabelText(en.weldpanel.analytics.save.nameLabel);
    await userEvent.clear(input);
    await userEvent.type(input, 'Signups per week');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ name: 'Signups per week' }));
  });

  it('shares a private report with the workspace', async () => {
    state.update.mockResolvedValue(makeReport());
    render(<ReportsPage />);
    await userEvent.click(screen.getByRole('button', { name: tr.actions.replace('{name}', 'Checkout funnel') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: tr.makeShared }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ visibility: 'workspace' }));
  });

  it('asks before deleting, then deletes', async () => {
    state.remove.mockResolvedValue(undefined);
    render(<ReportsPage />);
    await userEvent.click(screen.getByRole('button', { name: tr.actions.replace('{name}', 'Weekly signups') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.delete }));
    expect(await screen.findByText(tr.deleteTitle.replace('{name}', 'Weekly signups'))).toBeTruthy();
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.weldpanel.analytics.common.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wpr_1'));
  });

  it('hides rename and delete without the permissions', async () => {
    state.allowed = new Set();
    render(<ReportsPage />);
    expect(screen.queryByRole('button', { name: new RegExp(tr.newReport) })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: tr.actions.replace('{name}', 'Weekly signups') }));
    expect(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.open })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: en.weldpanel.analytics.common.rename })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: en.weldpanel.analytics.common.delete })).toBeNull();
  });

  it('shows an empty state with the way to create one', () => {
    state.reports = [];
    render(<ReportsPage />);
    expect(screen.getByText(tr.emptyTitle)).toBeTruthy();
  });

  it('shows a retry when the list fails to load', async () => {
    state.isError = true;
    render(<ReportsPage />);
    expect(screen.getByText(tr.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.refetch).toHaveBeenCalled();
  });
});
