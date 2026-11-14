import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelFunnelSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, makeFunnelResult, makeLexicon } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import FunnelsPage from './page';

const state = vi.hoisted(() => ({
  canWatch: true,
  funnel: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  calls: [] as { spec: unknown; options: unknown }[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => (key === 'panel_recordings:read' ? state.canWatch : true) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelFunnel: (spec: unknown, options: unknown) => {
    state.calls.push({ spec, options });
    return state.funnel;
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

const tf = en.weldpanel.analytics.funnels;
const lastCall = () => state.calls[state.calls.length - 1]!;
const lastSpec = () => lastCall().spec as PanelFunnelSpec;

async function chooseEvent(label: string, name: string) {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByText(name));
}

describe('Funnels', () => {
  beforeEach(() => {
    state.canWatch = true;
    state.funnel = { data: { result: makeFunnelResult(), dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    state.calls = [];
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('starts with two steps and waits until the second has an event', () => {
    render(<FunnelsPage />);
    expect(lastSpec().steps).toHaveLength(2);
    expect(lastCall().options).toMatchObject({ enabled: false });
    expect(screen.getByText(tf.completeHint)).toBeTruthy();
  });

  it('runs once every step has an event, with the default window and order', async () => {
    render(<FunnelsPage />);
    await chooseEvent(tf.stepN.replace('{n}', '2'), 'Signed up');
    expect(lastCall().options).toMatchObject({ enabled: true });
    expect(lastSpec()).toMatchObject({
      kind: 'funnel',
      projectId: 'wpp_1',
      steps: [{ event: '$pageview' }, { event: 'Signed up' }],
      window: { value: 7, unit: 'day' },
      order: 'loose',
    });
  });

  it('adds, moves and removes steps (never below two)', async () => {
    render(<FunnelsPage />);
    await userEvent.click(screen.getByRole('button', { name: tf.addStep }));
    expect(lastSpec().steps).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: tf.moveUp.replace('{n}', '3') }));
    await userEvent.click(screen.getByRole('button', { name: tf.removeStep.replace('{n}', '3') }));
    expect(lastSpec().steps).toHaveLength(2);
    expect(screen.queryByRole('button', { name: tf.removeStep.replace('{n}', '2') })).toBeNull();
  });

  it('switches to strict order and changes the window', async () => {
    render(<FunnelsPage />);
    await userEvent.click(screen.getByRole('radio', { name: tf.orders.strict }));
    expect(lastSpec().order).toBe('strict');
    const input = screen.getByLabelText(tf.window, { selector: 'input' });
    await userEvent.clear(input);
    await userEvent.type(input, '14');
    expect(lastSpec().window).toEqual({ value: 14, unit: 'day' });
  });

  describe('with a result', () => {
    beforeEach(async () => {
      render(<FunnelsPage />);
      await chooseEvent(tf.stepN.replace('{n}', '2'), 'Signed up');
    });

    it('shows the people, the conversion and the time to convert of each step', () => {
      expect(screen.getByText('1,000 people')).toBeTruthy();
      expect(screen.getByText('250 people', { exact: false })).toBeTruthy();
      expect(screen.getAllByText('25%', { exact: false }).length).toBeGreaterThan(0);
      expect(screen.getByText('Takes 1m 30s')).toBeTruthy();
      expect(screen.getByText('750 dropped off')).toBeTruthy();
    });

    it('links each drop-off to the recordings of those people', () => {
      const link = screen.getByRole('link', { name: tf.watch.droppedAt });
      const [path, query] = link.getAttribute('href')!.split('?');
      expect(path).toBe('/weldpanel/recordings');
      const params = new URLSearchParams(query);
      expect(JSON.parse(params.get('did')!)).toEqual(['$pageview']);
      expect(JSON.parse(params.get('didNot')!)).toEqual(['Signed up']);
      expect(params.get('range')).toBe('30d');
      expect(params.get('project')).toBe('wpp_1');
    });

    it('links the people who completed a step', () => {
      const links = screen.getAllByRole('link', { name: tf.watch.completed });
      expect(links).toHaveLength(2);
      expect(JSON.parse(new URLSearchParams(links[1]!.getAttribute('href')!.split('?')[1]).get('did')!)).toEqual(['Signed up']);
    });
  });

  it('leaves the recordings links out without the recordings permission', async () => {
    state.canWatch = false;
    render(<FunnelsPage />);
    await chooseEvent(tf.stepN.replace('{n}', '2'), 'Signed up');
    expect(screen.getByText('750 dropped off')).toBeTruthy();
    expect(screen.queryByRole('link', { name: tf.watch.droppedAt })).toBeNull();
  });

  it('compares breakdown values in a table', async () => {
    const base = makeFunnelResult();
    state.funnel = {
      data: { result: { ...base, breakdowns: [{ value: 'NL', steps: base.steps, overallConversion: 0.25 }] }, dataAsOf: DATA_AS_OF, cached: false },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    render(<FunnelsPage />);
    await chooseEvent(tf.stepN.replace('{n}', '2'), 'Signed up');
    const table = screen.getByRole('table');
    expect(within(table).getByText('NL')).toBeTruthy();
  });
});
