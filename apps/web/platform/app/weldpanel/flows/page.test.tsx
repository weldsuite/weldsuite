import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFlowsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, makeFlowsResult, makeLexicon } from '../analytics-fixtures';
import { flowColumns } from '../components/results/flows-result';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import FlowsPage from './page';

const state = vi.hoisted(() => ({
  flows: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
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
  useWeldPanelFlows: (spec: unknown, options: unknown) => {
    state.calls.push({ spec, options });
    return state.flows;
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

const tf = en.weldpanel.analytics.flows;
const lastSpec = () => state.calls[state.calls.length - 1]!.spec as PanelFlowsSpec;

describe('flowColumns', () => {
  it('sums the path counts per value at each step, most common first', () => {
    const columns = flowColumns(makeFlowsResult());
    expect(columns[0]?.rows).toEqual([
      { value: '/signup', count: 40 },
      { value: '/docs', count: 25 },
      { value: null, count: 20 },
    ]);
    expect(columns[1]?.rows).toEqual([
      { value: null, count: 45 },
      { value: '/welcome', count: 40 },
    ]);
    expect(columns[1]?.total).toBe(85);
  });
});

describe('Flows', () => {
  beforeEach(() => {
    state.flows = { data: { result: makeFlowsResult(), dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    state.calls = [];
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('shows the paths after a pageview, three steps deep', () => {
    render(<FlowsPage />);
    expect(lastSpec()).toMatchObject({ kind: 'flows', projectId: 'wpp_1', anchor: { event: '$pageview' }, direction: 'after', depth: 3, scope: 'all' });
  });

  it('shows the anchor, the step columns and where people left', () => {
    render(<FlowsPage />);
    expect(screen.getByText('100 times')).toBeTruthy();
    expect(screen.getByText(tf.stepN.replace('{n}', '1'))).toBeTruthy();
    expect(screen.getAllByText('/signup').length).toBeGreaterThan(0);
    expect(screen.getAllByText(tf.left).length).toBeGreaterThan(0);
  });

  it('lists the most common whole paths with their share of the anchor', () => {
    render(<FlowsPage />);
    const paths = screen.getByRole('region', { name: tf.pathsTitle });
    expect(within(paths).getByText('/pricing → /signup → /welcome')).toBeTruthy();
    expect(within(paths).getByText(/40 · 40% of 100/)).toBeTruthy();
  });

  it('reads backwards for paths before the event', async () => {
    state.flows = {
      data: { result: makeFlowsResult({ direction: 'before', paths: [{ steps: ['/pricing', '/home'], count: 10 }] }), dataAsOf: DATA_AS_OF, cached: false },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    render(<FlowsPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tf.direction }));
    await userEvent.click(await screen.findByRole('option', { name: tf.directions.before }));
    expect(lastSpec().direction).toBe('before');
    expect(screen.getByText('/home → /pricing → /pricing')).toBeTruthy();
  });

  it('says so when there are no paths', () => {
    state.flows = { data: { result: makeFlowsResult({ paths: [] }), dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<FlowsPage />);
    expect(screen.getByText(tf.noPaths)).toBeTruthy();
  });
});
