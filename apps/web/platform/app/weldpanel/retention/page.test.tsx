import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelRetentionSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, makeLexicon, makeRetentionResult } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import RetentionPage from './page';

const state = vi.hoisted(() => ({
  retention: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  calls: [] as { spec: unknown; options: unknown }[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelRetention: (spec: unknown, options: unknown) => {
    state.calls.push({ spec, options });
    return state.retention;
  },
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelCohorts: () => ({ data: [] }),
  useWeldPanelReport: () => ({ data: undefined, isLoading: false, isError: false }),
  useCreateWeldPanelReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateWeldPanelReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWeldPanelDashboards: () => ({ data: [] }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tr = en.weldpanel.analytics.retention;
const lastSpec = () => state.calls[state.calls.length - 1]!.spec as PanelRetentionSpec;

describe('Retention', () => {
  beforeEach(() => {
    state.retention = { data: { result: makeRetentionResult(), dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    state.calls = [];
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('runs weekly retention of the first pageview over 8 periods', () => {
    render(<RetentionPage />);
    expect(lastSpec()).toMatchObject({ kind: 'retention', projectId: 'wpp_1', firstEvent: '$pageview', interval: 'week', periods: 8 });
  });

  it('shows the cohort grid with sizes, shares and the average', () => {
    render(<RetentionPage />);
    expect(screen.getByRole('columnheader', { name: 'Week 0' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Week 2' })).toBeTruthy();
    expect(screen.getByTitle('40 of 100 users (40%)')).toBeTruthy();
    expect(screen.getByText(tr.average)).toBeTruthy();
    expect(screen.getByText('39%')).toBeTruthy();
  });

  it('counts any event as a return until one is chosen, and goes back to any', async () => {
    render(<RetentionPage />);
    expect(lastSpec().returnEvent).toBeUndefined();
    await userEvent.click(screen.getByRole('combobox', { name: tr.returnEvent }));
    await userEvent.click(await screen.findByText('Signed up'));
    expect(lastSpec().returnEvent).toBe('Signed up');
    await userEvent.click(screen.getByRole('button', { name: tr.anyEvent }));
    expect(lastSpec().returnEvent).toBeUndefined();
  });

  it('changes the period', async () => {
    render(<RetentionPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tr.interval }));
    await userEvent.click(await screen.findByRole('option', { name: tr.intervals.month }));
    expect(lastSpec().interval).toBe('month');
  });

  it('shows a loading skeleton, not a grid, while the first result loads', () => {
    state.retention = { data: undefined, error: null, isLoading: true, isFetching: true, refetch: vi.fn() };
    render(<RetentionPage />);
    expect(screen.queryByRole('table')).toBeNull();
  });
});
