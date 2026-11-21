import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeGroup, makeGroupType } from '../explore-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import GroupsPage from './page';

const state = vi.hoisted(() => ({
  allowed: new Set(['panel_people:read', 'panel_people:delete']),
  types: [] as unknown[],
  groups: [] as unknown[],
  listCalls: [] as unknown[],
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  useObjectPanelNavigationReporter: () => () => undefined,
}));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () => {
  const { analysisHooksMock } = await import('../explore-test-mocks');
  return analysisHooksMock({
    useWeldPanelGroupTypes: () => ({ data: state.types, isLoading: false, isError: false, refetch: vi.fn() }),
    useWeldPanelGroups: (params: unknown) => {
      state.listCalls.push(params);
      return { data: { groups: state.groups }, error: null, isLoading: false, refetch: vi.fn(), hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false };
    },
  });
});

const tx = en.weldpanel.explore.groups;

beforeEach(() => {
  state.allowed = new Set(['panel_people:read', 'panel_people:delete']);
  state.types = [];
  state.groups = [];
  state.listCalls = [];
  state.push.mockReset();
  panelOpen.mockReset();
  window.localStorage.clear();
  resetCurrentProjectChoice();
});

describe('Groups', () => {
  it('explains where groups come from when the project has none', () => {
    render(<GroupsPage />);
    expect(screen.getByText(tx.noTypesTitle)).toBeTruthy();
  });

  it('lists the first type’s groups and opens a group in the record panel from its row', async () => {
    state.types = [makeGroupType(), makeGroupType({ id: 'pngt_2', groupType: 'workspace', nameSingular: 'Workspace', namePlural: 'Workspaces' })];
    state.groups = [makeGroup()];
    render(<GroupsPage />);
    expect(state.listCalls[state.listCalls.length - 1]).toMatchObject({ projectId: 'wpp_1', type: 'company' });
    expect(screen.getByRole('combobox', { name: tx.type })).toBeTruthy();
    expect(screen.getByText('Acme Inc')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.view }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'panel_group', id: 'wpp_1~company~acme' });
  });

  it('needs the people permission', () => {
    state.allowed = new Set();
    render(<GroupsPage />);
    expect(screen.getByText(en.weldpanel.observe.common.noPermission)).toBeTruthy();
  });
});
