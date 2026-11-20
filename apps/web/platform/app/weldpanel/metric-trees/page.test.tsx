import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeLexicon } from '../analytics-fixtures';
import { makeMetricTree, makeMetricTreeValues } from '../explore-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import MetricTreePage from './detail/page';
import MetricTreesPage from './page';

const state = vi.hoisted(() => ({
  trees: [] as unknown[],
  tree: undefined as unknown,
  values: undefined as unknown,
  create: vi.fn(),
  push: vi.fn(),
  params: { treeId: 'pnmt_1' } as Record<string, string>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => state.params }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelReports: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () => {
  const { analysisHooksMock, idleMutation } = await import('../explore-test-mocks');
  return analysisHooksMock({
    useWeldPanelMetricTrees: () => ({ data: state.trees, isLoading: false, isError: false, refetch: vi.fn() }),
    useWeldPanelMetricTree: () => ({ data: state.tree, isLoading: false, error: null, refetch: vi.fn() }),
    useWeldPanelMetricTreeValues: () => ({ data: state.values, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
    useCreateWeldPanelMetricTree: () => ({ ...idleMutation, mutateAsync: state.create }),
    useUpdateWeldPanelMetricTree: () => idleMutation,
    useDeleteWeldPanelMetricTree: () => idleMutation,
  });
});

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tx = en.weldpanel.explore.metricTrees;

beforeEach(() => {
  state.trees = [];
  state.tree = undefined;
  state.values = undefined;
  state.create.mockReset();
  state.push.mockReset();
  window.localStorage.clear();
  resetCurrentProjectChoice();
});

describe('Metric trees list', () => {
  it('says what a metric tree is when there is none', () => {
    render(<MetricTreesPage />);
    expect(screen.getByText(tx.emptyTitle)).toBeTruthy();
  });

  it('lists trees and opens one from its row', async () => {
    state.trees = [makeMetricTree()];
    render(<MetricTreesPage />);
    expect(screen.getByText('Revenue drivers')).toBeTruthy();
    expect(screen.getByText('2 metrics')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.view }));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/metric-trees/pnmt_1');
  });

  it('creates a tree with a root measured by an event, then opens it', async () => {
    state.create.mockResolvedValue(makeMetricTree({ id: 'pnmt_9' }));
    render(<MetricTreesPage />);
    await userEvent.click(screen.getAllByRole('button', { name: tx.newTree })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.common.name), 'Growth');
    await userEvent.type(within(dialog).getByLabelText(tx.editor.root), 'Signups');
    await userEvent.click(within(dialog).getByRole('combobox', { name: `${tx.editor.event} Signups` }));
    await userEvent.click(await screen.findByText('Signed up'));
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'wpp_1',
        name: 'Growth',
        nodes: [{ id: 'root', label: 'Signups', parentId: null, relation: null, metric: { spec: { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Signed up', math: 'total', filters: [] }] } } }],
      }),
    );
    expect(state.push).toHaveBeenCalledWith('/weldpanel/metric-trees/pnmt_9');
  });

  it('refuses to save a metric without a measure', async () => {
    render(<MetricTreesPage />);
    await userEvent.click(screen.getAllByRole('button', { name: tx.newTree })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.common.name), 'Growth');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.common.save }));
    expect(within(dialog).getByText(tx.editor.incomplete)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe('Metric tree view', () => {
  it('shows every node with its value, change and errors', () => {
    state.tree = makeMetricTree();
    state.values = makeMetricTreeValues();
    render(<MetricTreePage />);
    expect(screen.getAllByText('Revenue drivers').length).toBeGreaterThan(0);
    expect(screen.getByText('5,000')).toBeTruthy();
    expect(screen.getByText('+25%')).toBeTruthy();
    expect(screen.getByText(tx.view.errors.report_not_found)).toBeTruthy();
    expect(screen.getByRole('button', { name: tx.view.edit })).toBeTruthy();
  });
});
