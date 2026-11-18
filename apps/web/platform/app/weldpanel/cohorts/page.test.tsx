import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeCohort, makeLexicon } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import CohortsPage from './page';

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  cohorts: [] as unknown[],
  isError: false,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelCohorts: () => ({ data: state.isError ? undefined : state.cohorts, isLoading: false, isError: state.isError, refetch: vi.fn() }),
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useCreateWeldPanelCohort: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelCohort: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelCohort: () => ({ mutateAsync: state.remove, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tc = en.weldpanel.analytics.cohorts;

describe('Cohorts', () => {
  beforeEach(() => {
    state.allowed = new Set(['panel_reports:create', 'panel_reports:update', 'panel_reports:delete']);
    state.cohorts = [makeCohort()];
    state.isError = false;
    state.create.mockReset();
    state.update.mockReset();
    state.remove.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the cohorts with their rule in words', () => {
    render(<CohortsPage />);
    expect(screen.getByText('Pro users')).toBeTruthy();
    expect(screen.getByText('All of: plan is pro')).toBeTruthy();
  });

  it('shows an empty state', () => {
    state.cohorts = [];
    render(<CohortsPage />);
    expect(screen.getByText(tc.emptyTitle)).toBeTruthy();
  });

  it('needs a name and complete conditions before it saves', async () => {
    render(<CohortsPage />);
    await userEvent.click(screen.getAllByRole('button', { name: tc.newCohort })[0]!);
    const dialog = await screen.findByRole('dialog', { name: tc.createTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    expect(await within(dialog).findByText(tc.nameRequired)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.common.name), 'Trials');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    expect(await within(dialog).findByText(tc.incomplete)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('creates a cohort from a user property', async () => {
    state.create.mockResolvedValue(makeCohort());
    render(<CohortsPage />);
    await userEvent.click(screen.getAllByRole('button', { name: tc.newCohort })[0]!);
    const dialog = await screen.findByRole('dialog', { name: tc.createTitle });
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.common.name), 'Pro users');
    await userEvent.click(within(dialog).getByRole('combobox', { name: `${tc.property} 1` }));
    await userEvent.click(await screen.findByText('plan'));
    await userEvent.type(within(dialog).getByLabelText(tc.value), 'pro');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toEqual({
      projectId: 'wpp_1',
      name: 'Pro users',
      description: null,
      filter: { match: 'all', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] },
    });
  });

  it('adds an event condition ("did not do X in N days")', async () => {
    state.create.mockResolvedValue(makeCohort());
    render(<CohortsPage />);
    await userEvent.click(screen.getAllByRole('button', { name: tc.newCohort })[0]!);
    const dialog = await screen.findByRole('dialog', { name: tc.createTitle });
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.common.name), 'Not upgraded');
    await userEvent.click(within(dialog).getByRole('combobox', { name: tc.conditionTypes.person_property }));
    await userEvent.click(await screen.findByRole('option', { name: tc.conditionTypes.performed }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: `${tc.event} 1` }));
    await userEvent.click(await screen.findByText('Upgraded'));
    await userEvent.click(within(dialog).getByRole('combobox', { name: tc.performed }));
    await userEvent.click(await screen.findByRole('option', { name: tc.didNot }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0].filter.conditions[0]).toMatchObject({ type: 'performed', event: 'Upgraded', negate: true, withinDays: 30 });
  });

  it('edits an existing cohort with its conditions filled in', async () => {
    state.update.mockResolvedValue(makeCohort());
    render(<CohortsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.reports.actions.replace('{name}', 'Pro users') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.edit }));
    const dialog = await screen.findByRole('dialog', { name: tc.editTitle });
    expect((within(dialog).getByLabelText(en.weldpanel.analytics.common.name) as HTMLInputElement).value).toBe('Pro users');
    expect((within(dialog).getByLabelText(tc.value) as HTMLInputElement).value).toBe('pro');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({ name: 'Pro users' });
  });

  it('asks before deleting', async () => {
    state.remove.mockResolvedValue(undefined);
    render(<CohortsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.reports.actions.replace('{name}', 'Pro users') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.weldpanel.analytics.common.delete }));
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.weldpanel.analytics.common.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wpc_1'));
  });

  it('is read-only without the permissions', () => {
    state.allowed = new Set();
    render(<CohortsPage />);
    expect(screen.queryByRole('button', { name: tc.newCohort })).toBeNull();
    expect(screen.queryByRole('button', { name: en.weldpanel.analytics.reports.actions.replace('{name}', 'Pro users') })).toBeNull();
  });
});
