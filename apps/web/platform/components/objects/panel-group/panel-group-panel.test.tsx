import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';
import { makeGroupProfile, makeGroupType } from '@/app/weldpanel/explore-fixtures';
import { resetCurrentProjectChoice } from '@/app/weldpanel/lib/use-current-project';
import { makeProject } from '@/app/weldpanel/test-fixtures';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { PanelGroupPanel } from './panel-group-panel';
import { panelGroupHref, panelGroupId, parsePanelGroupId } from './panel-group-tabs';

const state = vi.hoisted(() => ({
  allowed: new Set(['panel_people:read', 'panel_people:delete']),
  profile: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown, refetch: vi.fn() },
  remove: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.allowed.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', () => ({
  useWeldPanelGroupTypes: () => ({ data: [makeGroupType()] }),
  useWeldPanelGroup: () => state.profile,
  useDeleteWeldPanelGroup: () => ({ mutateAsync: state.remove, isPending: false }),
}));

const tp = en.weldpanel.explore.groups.profile;
const ok = (data = makeGroupProfile()) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

function renderPanel(onClose = vi.fn()) {
  renderWithProviders(<PanelGroupPanel id={panelGroupId('wpp_1', 'company', 'acme')} isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />);
  return onClose;
}

describe('panel group ids and links', () => {
  it('carries project, type and key, safe for the stack URL', () => {
    const id = panelGroupId('wpp_1', 'company', 'acme:inc,~eu');
    expect(id).not.toMatch(/[:,]/);
    expect(parsePanelGroupId(id)).toEqual({ projectId: 'wpp_1', groupType: 'company', groupKey: 'acme:inc,~eu' });
  });

  it('turns the old profile URL into the Groups list of that type with the panel in fullscreen', () => {
    expect(panelGroupHref('wpp_1', 'company', 'acme')).toBe('/weldpanel/groups?type=company&stack=panel_group:wpp_1~company~acme:fullscreen');
  });
});

describe('PanelGroupPanel', () => {
  beforeEach(() => {
    state.allowed = new Set(['panel_people:read', 'panel_people:delete']);
    state.profile = ok();
    state.remove.mockReset();
    state.push.mockReset();
    state.toast.success.mockReset();
    panelOpen.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('shows the group with its numbers and properties as rows, and links to the CRM company', async () => {
    renderPanel();
    expect(screen.getByText('Acme Inc')).toBeTruthy();
    expect(screen.getByText('acme.com')).toBeTruthy();
    expect(screen.getByText('420')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: tp.openInCrm }));
    expect(state.push).toHaveBeenCalledWith('/weldcrm/companies?stack=company:cus_1:panel');
  });

  it('opens a member on top of the group', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.members }));
    const member = makeGroupProfile().members[0]!;
    await userEvent.click(screen.getByRole('button', { name: member.distinctId }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'panel_person', id: `wpp_1~${encodeURIComponent(member.distinctId)}`, stack: true });
  });

  it('deletes the profile from the menu and closes the panel', async () => {
    state.remove.mockResolvedValue(undefined);
    const onClose = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: en.sweep.entities.moreActions }));
    await userEvent.click(await screen.findByRole('menuitem', { name: tp.delete }));
    const confirm = await screen.findAllByRole('button', { name: tp.delete });
    await userEvent.click(confirm[confirm.length - 1]!);
    expect(state.remove).toHaveBeenCalledWith({ groupType: 'company', groupKey: 'acme' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says when a group is only known from its events, and offers no delete then', () => {
    state.profile = ok(makeGroupProfile({ hasProfile: false, crmCompany: null }));
    renderPanel();
    expect(screen.getByText(tp.noProfile)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.sweep.entities.moreActions })).toBeNull();
    expect(screen.queryByRole('button', { name: tp.openInCrm })).toBeNull();
  });

  it('says so for a group that does not exist', () => {
    state.profile = { data: undefined, isLoading: false, isError: true, error: new ApiError('Not found', 404), refetch: vi.fn() };
    renderPanel();
    expect(screen.getByText(tp.notFound)).toBeTruthy();
  });
});
