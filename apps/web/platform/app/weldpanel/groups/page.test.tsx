import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeGroup, makeGroupProfile, makeGroupType } from '../explore-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import GroupProfilePage from './detail/page';
import GroupsPage from './page';

const state = vi.hoisted(() => ({
  allowed: new Set(['panel_people:read', 'panel_people:delete']),
  types: [] as unknown[],
  groups: [] as unknown[],
  listCalls: [] as unknown[],
  profile: undefined as unknown,
  remove: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ groupType: 'company', groupKey: 'acme' }) }));
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
  const { analysisHooksMock, idleMutation } = await import('../explore-test-mocks');
  return analysisHooksMock({
    useWeldPanelGroupTypes: () => ({ data: state.types, isLoading: false, isError: false, refetch: vi.fn() }),
    useWeldPanelGroups: (params: unknown) => {
      state.listCalls.push(params);
      return { data: { groups: state.groups }, error: null, isLoading: false, refetch: vi.fn(), hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false };
    },
    useWeldPanelGroup: () => ({ data: state.profile, isLoading: false, error: null, refetch: vi.fn() }),
    useDeleteWeldPanelGroup: () => ({ ...idleMutation, mutateAsync: state.remove }),
  });
});

const tx = en.weldpanel.explore.groups;

beforeEach(() => {
  state.allowed = new Set(['panel_people:read', 'panel_people:delete']);
  state.types = [];
  state.groups = [];
  state.listCalls = [];
  state.profile = undefined;
  state.remove.mockReset();
  state.push.mockReset();
  window.localStorage.clear();
  resetCurrentProjectChoice();
});

describe('Groups', () => {
  it('explains where groups come from when the project has none', () => {
    render(<GroupsPage />);
    expect(screen.getByText(tx.noTypesTitle)).toBeTruthy();
  });

  it('lists the first type’s groups with a link to each profile', () => {
    state.types = [makeGroupType(), makeGroupType({ id: 'pngt_2', groupType: 'workspace', nameSingular: 'Workspace', namePlural: 'Workspaces' })];
    state.groups = [makeGroup()];
    render(<GroupsPage />);
    expect(state.listCalls[state.listCalls.length - 1]).toMatchObject({ projectId: 'wpp_1', type: 'company' });
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acme Inc' }).getAttribute('href')).toBe('/weldpanel/groups/company/acme?project=wpp_1');
  });

  it('needs the people permission', () => {
    state.allowed = new Set();
    render(<GroupsPage />);
    expect(screen.getByText(en.weldpanel.observe.common.noPermission)).toBeTruthy();
  });
});

describe('Group profile', () => {
  it('shows properties, the CRM company and deletes the profile', async () => {
    state.types = [makeGroupType()];
    state.profile = makeGroupProfile();
    state.remove.mockResolvedValue(undefined);
    render(<GroupProfilePage />);
    expect(screen.getByRole('heading', { name: 'Acme Inc' })).toBeTruthy();
    expect(screen.getByText('acme.com')).toBeTruthy();
    expect(screen.getByRole('link', { name: tx.profile.openInCrm }).getAttribute('href')).toBe('/weldcrm/companies?stack=company:cus_1:panel');
    expect(screen.getByText('420')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: tx.profile.delete }));
    const confirm = await screen.findAllByRole('button', { name: tx.profile.delete });
    await userEvent.click(confirm[confirm.length - 1]!);
    expect(state.remove).toHaveBeenCalledWith({ groupType: 'company', groupKey: 'acme' });
    expect(state.push).toHaveBeenCalledWith('/weldpanel/groups?type=company');
  });

  it('says when a group is only known from its events', () => {
    state.profile = makeGroupProfile({ hasProfile: false, crmCompany: null });
    render(<GroupProfilePage />);
    expect(screen.getByText(tx.profile.noProfile)).toBeTruthy();
    expect(screen.queryByRole('button', { name: tx.profile.delete })).toBeNull();
  });
});
