import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { PanelFilter, PanelWebSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, makeWebResult } from './analytics-fixtures';
import { makeInstall, makeProject } from './test-fixtures';
import { resetCurrentProjectChoice } from './lib/use-current-project';
import WeldPanelHome from './page';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  canCreate: true,
  projects: [] as unknown[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  web: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  webSpecs: [] as unknown[],
  live: { visitors: 3 } as { visitors: number } | undefined,
  create: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: state.isError ? undefined : state.projects, isLoading: state.isLoading, isError: state.isError, refetch: state.refetch }),
  useWeldPanelInstall: (projectId: string) => ({ data: makeInstall({ projectId }), isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWeldPanelProject: () => ({ mutateAsync: state.create, isPending: false }),
  useWeldPanelWeb: (spec: unknown) => {
    state.webSpecs.push(spec);
    return state.web;
  },
  useWeldPanelLive: () => ({ data: state.live }),
  useWeldPanelCohorts: () => ({ data: [] }),
  useWeldPanelLexicon: () => ({ data: undefined }),
}));

const th = en.weldpanel.home;
const to = en.weldpanel.analytics.overview;

function lastSpec(): PanelWebSpec {
  return state.webSpecs[state.webSpecs.length - 1] as PanelWebSpec;
}

function setData(result = makeWebResult()) {
  state.web = { data: { result, dataAsOf: DATA_AS_OF, cached: true }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
}

describe('WeldPanel home', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.canCreate = true;
    state.projects = [];
    state.isLoading = false;
    state.isError = false;
    state.refetch.mockReset();
    state.web = { data: undefined, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    state.webSpecs = [];
    state.live = { visitors: 3 };
    state.create.mockReset();
    state.push.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  afterEach(() => window.localStorage.clear());

  describe('without projects', () => {
    it('shows the empty state and the three steps', () => {
      render(<WeldPanelHome />);
      expect(screen.getByText(th.emptyTitle)).toBeTruthy();
      for (const step of Object.values(th.steps)) expect(screen.getByText(step.title)).toBeTruthy();
    });

    it('has an enabled New project button that opens the create dialog', async () => {
      render(<WeldPanelHome />);
      const button = screen.getByRole('button', { name: th.newProject }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      await userEvent.click(button);
      expect(await screen.findByRole('dialog', { name: en.weldpanel.createDialog.title })).toBeTruthy();
    });

    it('validates the name in the dialog before creating', async () => {
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: th.newProject }));
      await userEvent.click(await screen.findByRole('button', { name: en.weldpanel.createDialog.submit }));
      expect(await screen.findByText(en.weldpanel.validation.nameRequired)).toBeTruthy();
      expect(state.create).not.toHaveBeenCalled();
    });

    it('creates a project and goes to its install tab', async () => {
      state.create.mockResolvedValue(makeProject({ id: 'wpp_new' }));
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: th.newProject }));
      await userEvent.type(await screen.findByLabelText(en.weldpanel.general.nameLabel), 'Docs');
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.createDialog.submit }));
      await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
      expect(state.create.mock.calls[0]?.[0]).toMatchObject({ name: 'Docs', kind: 'website' });
      await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/projects/wpp_new'));
    });

    it('explains instead of offering a button without the create permission', () => {
      state.canCreate = false;
      render(<WeldPanelHome />);
      expect(screen.queryByRole('button', { name: th.newProject })).toBeNull();
      expect(screen.getByText(th.emptyNoCreate)).toBeTruthy();
    });
  });

  it('shows a loader while the projects load', () => {
    state.isLoading = true;
    render(<WeldPanelHome />);
    expect(screen.queryByText(th.emptyTitle)).toBeNull();
  });

  it('offers a retry when the projects fail to load', async () => {
    state.isError = true;
    render(<WeldPanelHome />);
    expect(screen.getByText(th.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.refetch).toHaveBeenCalled();
  });

  describe('the Overview of a project', () => {
    beforeEach(() => {
      state.projects = [makeProject({ id: 'wpp_1', name: 'Marketing site' }), makeProject({ id: 'wpp_2', name: 'Docs' })];
    });

    it('asks the API for the last 30 days with a comparison', () => {
      setData();
      render(<WeldPanelHome />);
      expect(lastSpec()).toMatchObject({ kind: 'web', projectId: 'wpp_1', dateRange: { preset: '30d' }, compare: true, filters: [] });
    });

    it('has one page title, not one per wrapper', () => {
      setData();
      render(<WeldPanelHome />);
      expect(screen.getAllByRole('heading', { level: 1, name: to.title })).toHaveLength(1);
    });

    it('shows the KPI tiles with the change against the previous period', () => {
      setData();
      render(<WeldPanelHome />);
      expect(screen.getAllByText(to.kpi.visitors).length).toBeGreaterThan(0);
      expect(screen.getAllByText('1,200').length).toBeGreaterThan(0);
      expect(screen.getByText('4,200')).toBeTruthy();
      expect(screen.getByText('42%')).toBeTruthy();
      expect(screen.getByText('1m 23s')).toBeTruthy();
      // 1,200 visitors against 1,000 before.
      expect(screen.getAllByText('+20%').length).toBeGreaterThan(0);
    });

    it('shows how fresh the data is, and that it was cached', () => {
      setData();
      render(<WeldPanelHome />);
      expect(screen.getByText(/Data as of/)).toBeTruthy();
      expect(screen.getByText(en.weldpanel.analytics.freshness.cached)).toBeTruthy();
    });

    it('shows the visitors online now', () => {
      setData();
      render(<WeldPanelHome />);
      expect(screen.getByText('3 online now')).toBeTruthy();
      expect(screen.getByText('3 online now').closest('a')?.getAttribute('href')).toBe('/weldpanel/live');
    });

    it('says when nobody is online', () => {
      state.live = { visitors: 0 };
      setData();
      render(<WeldPanelHome />);
      expect(screen.getByText(to.liveNone)).toBeTruthy();
    });

    it('lists the top pages and switches to entry pages', async () => {
      setData();
      render(<WeldPanelHome />);
      expect(screen.getByText('/pricing')).toBeTruthy();
      await userEvent.click(screen.getByRole('tab', { name: to.pages.entry }));
      expect(screen.queryByText('/pricing')).toBeNull();
      expect(screen.getByText('/checkout')).toBeTruthy();
    });

    it('filters the page by clicking a country, and removes the filter by clicking it again', async () => {
      setData();
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: to.filterRow.replace('{value}', 'Netherlands') }));
      const filter: PanelFilter = { source: 'column', field: 'country', operator: 'eq', value: 'NL' };
      expect(lastSpec().filters).toEqual([filter]);
      expect(screen.getByText('Country is NL')).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: to.filterRow.replace('{value}', 'Netherlands') }));
      expect(lastSpec().filters).toEqual([]);
    });

    it('does not filter on the direct (empty) referrer', async () => {
      setData();
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: to.filterRow.replace('{value}', to.sources.direct) }));
      expect(lastSpec().filters).toEqual([]);
    });

    it('changes the date range from the picker', async () => {
      setData();
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: /Date range/ }));
      await userEvent.click(await screen.findByRole('button', { name: en.weldpanel.analytics.range['7d'] }));
      expect(lastSpec().dateRange).toEqual({ preset: '7d' });
      // Remembered for the other analytics pages.
      expect(window.localStorage.getItem('weldpanel:range')).toBe(JSON.stringify({ preset: '7d' }));
    });

    it('turns the comparison off', async () => {
      setData();
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('switch', { name: en.weldpanel.analytics.range.compare }));
      expect(lastSpec().compare).toBe(false);
    });

    it('shows a calm notice, not an error, when analytics is not configured (503)', () => {
      state.web = { data: undefined, error: new ApiError('unavailable', 503), isLoading: false, isFetching: false, refetch: vi.fn() };
      render(<WeldPanelHome />);
      expect(screen.getByText(en.weldpanel.analytics.errors.notConfiguredTitle)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      // The install status is still there: collecting works.
      expect(screen.getByText(en.weldpanel.install.waiting)).toBeTruthy();
    });

    it('offers a retry on any other failure', async () => {
      const refetch = vi.fn();
      state.web = { data: undefined, error: new ApiError('boom', 502), isLoading: false, isFetching: false, refetch };
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.errors.retry }));
      expect(refetch).toHaveBeenCalled();
    });

    it('keeps the install state for a project that never received an event', () => {
      setData(makeWebResult({ totals: { visitors: 0, visits: 0, pageviews: 0, bounceRate: 0, avgVisitDurationSeconds: 0 }, previousTotals: null }));
      render(<WeldPanelHome />);
      expect(screen.getByText(to.waitingTitle)).toBeTruthy();
      expect(screen.getByText(en.weldpanel.install.waiting)).toBeTruthy();
      expect(screen.queryByText(to.kpi.visitors)).toBeNull();
    });

    it('shows skeletons while the first result loads', () => {
      state.web = { data: undefined, error: null, isLoading: true, isFetching: true, refetch: vi.fn() };
      render(<WeldPanelHome />);
      expect(screen.getByText(to.kpi.visitors)).toBeTruthy();
      expect(screen.queryByText('1,200')).toBeNull();
    });

    it('formats in Dutch', () => {
      state.locale = 'nl';
      setData();
      render(<WeldPanelHome />);
      expect(screen.getAllByText(nl.weldpanel.analytics.overview.kpi.visitors).length).toBeGreaterThan(0);
      expect(screen.getAllByText('1.200').length).toBeGreaterThan(0);
    });
  });
});
