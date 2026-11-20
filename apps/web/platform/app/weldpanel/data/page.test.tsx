import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { makeLexicon } from '../analytics-fixtures';
import { makeComputedProperty, makeCustomEvent, makeGroupType, makePathRule } from '../explore-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import DataPage from './page';
import { definitionSummary, propertyFormulaProblem } from './computed-properties-tab';

const state = vi.hoisted(() => ({
  search: '',
  allowed: new Set(['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete']),
  customEvents: [] as unknown[],
  computed: [] as unknown[],
  rules: [] as unknown[],
  groupTypes: [] as unknown[],
  createEvent: vi.fn(),
  createProperty: vi.fn(),
  replaceRules: vi.fn(),
  testRules: vi.fn(),
  createGroupType: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelCohorts: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () => {
  const { analysisHooksMock, idleMutation } = await import('../explore-test-mocks');
  const list = (key: 'customEvents' | 'computed' | 'rules' | 'groupTypes') => () => ({ data: state[key], isLoading: false, isError: false, refetch: vi.fn() });
  return analysisHooksMock({
    useWeldPanelCustomEvents: list('customEvents'),
    useWeldPanelComputedProperties: list('computed'),
    useWeldPanelPathRules: list('rules'),
    useWeldPanelGroupTypes: list('groupTypes'),
    useCreateWeldPanelCustomEvent: () => ({ ...idleMutation, mutateAsync: state.createEvent }),
    useUpdateWeldPanelCustomEvent: () => idleMutation,
    useDeleteWeldPanelCustomEvent: () => idleMutation,
    useCreateWeldPanelComputedProperty: () => ({ ...idleMutation, mutateAsync: state.createProperty }),
    useUpdateWeldPanelComputedProperty: () => idleMutation,
    useDeleteWeldPanelComputedProperty: () => idleMutation,
    useReplaceWeldPanelPathRules: () => ({ ...idleMutation, mutateAsync: state.replaceRules }),
    useTestWeldPanelPathRules: () => ({ ...idleMutation, mutateAsync: state.testRules }),
    useCreateWeldPanelGroupType: () => ({ ...idleMutation, mutateAsync: state.createGroupType }),
    useUpdateWeldPanelGroupType: () => idleMutation,
    useDeleteWeldPanelGroupType: () => idleMutation,
  });
});

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const td = en.weldpanel.explore.data;
const tc = en.weldpanel.analytics.common;

beforeEach(() => {
  state.search = '';
  state.allowed = new Set(['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete']);
  state.customEvents = [];
  state.computed = [];
  state.rules = [];
  state.groupTypes = [];
  for (const fn of [state.createEvent, state.createProperty, state.replaceRules, state.testRules, state.createGroupType]) fn.mockReset();
  window.localStorage.clear();
  resetCurrentProjectChoice();
});

describe('computed property helpers', () => {
  it('check a formula with the query engine’s parser', () => {
    expect(propertyFormulaProblem('price * quantity')).toBeNull();
    expect(propertyFormulaProblem('')).toBeNull();
    expect(propertyFormulaProblem('price *')).toMatchObject({ position: expect.any(Number) });
  });

  it('summarise a definition in one line', () => {
    expect(definitionSummary(makeComputedProperty(), en.weldpanel.analytics.filters.columns)).toBe('price * quantity');
    const coalesce = makeComputedProperty({ definition: { kind: 'coalesce', keys: [{ source: 'event', key: 'plan' }, { source: 'column', field: 'utm_source' }] } });
    expect(definitionSummary(coalesce, en.weldpanel.analytics.filters.columns)).toBe('coalesce(plan, UTM source)');
  });
});

describe('Data', () => {
  it('lists custom events and creates one from two events', async () => {
    state.customEvents = [makeCustomEvent()];
    state.createEvent.mockResolvedValue(makeCustomEvent({ id: 'pnce_2' }));
    render(<DataPage />);
    expect(screen.getByText('Signed up or invited')).toBeTruthy();
    expect(screen.getByText('Signed up, Invited')).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: td.customEvents.new })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(tc.name), 'Engaged');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Event 1' }));
    await userEvent.click(await screen.findByText('Upgraded'));
    await userEvent.click(within(dialog).getByRole('button', { name: td.customEvents.addMatch }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Event 2' }));
    await userEvent.click(await screen.findByText('Signed up'));
    await userEvent.click(within(dialog).getByRole('button', { name: tc.save }));
    expect(state.createEvent).toHaveBeenCalledWith({
      projectId: 'wpp_1',
      name: 'Engaged',
      description: null,
      definition: { match: [{ event: 'Upgraded', filters: [] }, { event: 'Signed up', filters: [] }] },
    });
  });

  it('says when a custom event name is taken', async () => {
    state.createEvent.mockRejectedValue(new ApiError('taken', 409));
    render(<DataPage />);
    await userEvent.click(screen.getAllByRole('button', { name: td.customEvents.new })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(tc.name), 'Engaged');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Event 1' }));
    await userEvent.click(await screen.findByText('Upgraded'));
    await userEvent.click(within(dialog).getByRole('button', { name: tc.save }));
    expect(await within(dialog).findByText(td.customEvents.nameTaken)).toBeTruthy();
  });

  it('checks a computed property formula as it is typed', async () => {
    state.search = 'tab=computedProperties';
    render(<DataPage />);
    await userEvent.click(screen.getAllByRole('button', { name: td.computedProperties.new })[0]!);
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(td.computedProperties.expression);
    await userEvent.type(input, 'price *');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(input, ' quantity');
    expect(within(dialog).getByText(td.computedProperties.valid)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(tc.name), 'Order value');
    await userEvent.click(within(dialog).getByRole('button', { name: tc.save }));
    expect(state.createProperty).toHaveBeenCalledWith({ projectId: 'wpp_1', name: 'Order value', description: null, definition: { kind: 'formula', expression: 'price * quantity' } });
  });

  it('edits path rules, saves the ordered list and tries them on sample paths', async () => {
    state.search = 'tab=pathRules';
    state.rules = [makePathRule()];
    state.replaceRules.mockResolvedValue({ data: [] });
    state.testRules.mockResolvedValue([{ path: '/users/42', cleaned: '/users/:id', matched: [0] }]);
    render(<DataPage />);
    expect((screen.getByLabelText(td.pathRules.pattern) as HTMLInputElement).value).toBe('^/users/\\d+');

    await userEvent.click(screen.getAllByRole('button', { name: td.pathRules.add })[0]!);
    const patterns = screen.getAllByLabelText(td.pathRules.pattern);
    await userEvent.type(patterns[1]!, '\\?.*$');
    await userEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    await userEvent.click(screen.getByRole('button', { name: td.pathRules.save }));
    expect(state.replaceRules).toHaveBeenCalledWith({
      rules: [
        { pattern: '\\?.*$', replacement: '', description: null },
        { pattern: '^/users/\\d+', replacement: '/users/:id', description: null },
      ],
    });

    await userEvent.type(screen.getByLabelText(td.pathRules.test.title), '/users/42');
    await userEvent.click(screen.getByRole('button', { name: td.pathRules.test.run }));
    expect(state.testRules).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'wpp_1', paths: ['/users/42'] }));
    expect(await screen.findByText('/users/:id', { selector: 'span' })).toBeTruthy();
  });

  it('shows a pattern problem and will not save it', async () => {
    state.search = 'tab=pathRules';
    render(<DataPage />);
    await userEvent.click(screen.getAllByRole('button', { name: td.pathRules.add })[0]!);
    await userEvent.type(screen.getByLabelText(td.pathRules.pattern), '(?=x)');
    expect(screen.getByText('Lookarounds and backreferences are not supported')).toBeTruthy();
    expect((screen.getByRole('button', { name: td.pathRules.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('configures a group type the project collects', async () => {
    state.search = 'tab=groupTypes';
    state.groupTypes = [makeGroupType({ id: null, configured: false, nameSingular: 'Workspace', namePlural: 'Workspaces', groupType: 'workspace', crmMatchProperty: null })];
    state.createGroupType.mockResolvedValue(makeGroupType());
    render(<DataPage />);
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(td.groupTypes.groupType) as HTMLInputElement).value).toBe('workspace');
    await userEvent.click(within(dialog).getByRole('button', { name: tc.save }));
    expect(state.createGroupType).toHaveBeenCalledWith({ groupType: 'workspace', nameSingular: 'Workspace', namePlural: 'Workspaces', crmMatchProperty: null });
  });

  it('is read-only without the report permissions', () => {
    state.allowed = new Set(['panel_reports:read']);
    render(<DataPage />);
    expect(screen.getByText(td.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: td.customEvents.new })).toBeNull();
  });
});
