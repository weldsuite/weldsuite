import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';
import { resetCurrentProjectChoice } from '@/app/weldpanel/lib/use-current-project';
import { makeProfile, makeSession } from '@/app/weldpanel/observe-fixtures';
import { makeProject } from '@/app/weldpanel/test-fixtures';
import { PanelPersonPanel } from './panel-person-panel';
import { panelPersonHref, panelPersonId, parsePanelPersonId } from './panel-person-tabs';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_people:read', 'panel_people:delete', 'panel_recordings:read']),
  profile: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown, refetch: vi.fn() },
  personArgs: [] as string[][],
  erase: vi.fn(),
  push: vi.fn(),
  crmInstalled: true,
  crm: { data: undefined as unknown },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.crmInstalled, isLoading: false }) }));
vi.mock('@/components/objects/person/use-person-data', () => ({ usePersonSearch: () => state.crm }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelPerson: (projectId: string, distinctId: string) => {
    state.personArgs.push([projectId, distinctId]);
    return state.profile;
  },
  useEraseWeldPanelPerson: () => ({ mutateAsync: state.erase, isPending: false }),
}));

const tp = en.weldpanel.observe.person;
const ok = (data = makeProfile()) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const failed = (error: ApiError) => ({ data: undefined, isLoading: false, isError: true, error, refetch: vi.fn() });

function renderPanel(id = panelPersonId('wpp_1', 'user_42'), onClose = vi.fn()) {
  renderWithProviders(<PanelPersonPanel id={id} isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />);
  return onClose;
}

describe('panel person ids and links', () => {
  it('carries the project and an encoded distinct id, safe for the stack URL', () => {
    const id = panelPersonId('wpp_1', 'user:4,2');
    expect(id).not.toMatch(/[:,]/);
    expect(parsePanelPersonId(id)).toEqual({ projectId: 'wpp_1', distinctId: 'user:4,2' });
    expect(parsePanelPersonId('user_42')).toEqual({ projectId: '', distinctId: 'user_42' });
  });

  it('turns the old profile URL into the Users list with the panel in fullscreen', () => {
    expect(panelPersonHref('wpp_1', 'user_42', 'activity')).toBe('/weldpanel/users?stack=panel_person:wpp_1~user_42:fullscreen:tab=activity');
    expect(panelPersonHref('wpp_1', 'user_42', 'nope')).toBe('/weldpanel/users?stack=panel_person:wpp_1~user_42:fullscreen');
  });
});

describe('PanelPersonPanel', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_people:read', 'panel_people:delete', 'panel_recordings:read']);
    state.profile = ok();
    state.personArgs = [];
    state.erase.mockReset();
    state.push.mockReset();
    state.toast.success.mockReset();
    state.toast.error.mockReset();
    state.crmInstalled = true;
    state.crm = { data: undefined };
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('shows the person with their numbers and properties as rows', () => {
    renderPanel();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('321')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('pro')).toBeTruthy();
    expect(state.personArgs.at(-1)).toEqual(['wpp_1', 'user_42']);
  });

  it('reads a link without a project in the project picked in the sidebar', () => {
    renderPanel('user_42');
    expect(state.personArgs.at(-1)).toEqual(['wpp_1', 'user_42']);
  });

  it('lists recent activity as rows', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.activity }));
    expect(screen.getByText('Signed up')).toBeTruthy();
    expect(screen.getByText('$pageview')).toBeTruthy();
  });

  it('opens a recording from its row, and all of the person’s recordings from the tab', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.recordings }));
    await userEvent.click(screen.getByRole('button', { name: tp.watch }));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/recordings/ses_1?project=wpp_1');
    await userEvent.click(screen.getByRole('button', { name: tp.allRecordings }));
    const href = state.push.mock.calls.at(-1)![0] as string;
    expect(href).toContain('/weldpanel/recordings?');
    expect(href).toContain('user=user_42');
  });

  it('keeps recordings closed to people who may not watch them', async () => {
    state.perms = new Set(['panel_people:read']);
    renderPanel();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.recordings }));
    expect(screen.queryByRole('button', { name: tp.allRecordings })).toBeNull();
    expect(screen.queryByRole('button', { name: tp.watch })).toBeNull();
  });

  it('links to the WeldCRM person with the same email, and only then', async () => {
    state.crm = { data: { data: [{ id: 'per_9', email: 'ADA@example.com' }] } };
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: tp.openInCrm }));
    expect(state.push).toHaveBeenCalledWith('/weldcrm/people/per_9');
  });

  it('has no WeldCRM link when nobody matches', () => {
    state.crm = { data: { data: [{ id: 'per_9', email: 'someone@else.com' }] } };
    renderPanel();
    expect(screen.queryByRole('button', { name: tp.openInCrm })).toBeNull();
  });

  describe('erasure', () => {
    it('is only offered with the delete permission', () => {
      state.perms = new Set(['panel_people:read']);
      renderPanel();
      expect(screen.queryByRole('button', { name: en.sweep.entities.moreActions })).toBeNull();
    });

    it('needs the name typed, then erases and closes the panel', async () => {
      state.erase.mockResolvedValue({ userId: 'user_42', erasedIdCount: 3, recordingChunksDeleted: 12 });
      const onClose = renderPanel();
      await userEvent.click(screen.getByRole('button', { name: en.sweep.entities.moreActions }));
      await userEvent.click(await screen.findByRole('menuitem', { name: tp.erase.button }));
      const confirm = screen.getByRole('button', { name: tp.erase.confirm });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      await userEvent.type(screen.getByLabelText(tp.erase.prompt.replace('{name}', 'Ada Lovelace')), 'Ada Lovelace');
      await userEvent.click(confirm);
      expect(state.erase).toHaveBeenCalledWith('user_42');
      expect(state.toast.success).toHaveBeenCalledWith('Erased. 3 ids excluded, 12 recording chunks deleted.');
      expect(onClose).toHaveBeenCalled();
    });

    it('stays open when the erasure fails', async () => {
      state.erase.mockRejectedValue(new Error('boom'));
      const onClose = renderPanel();
      await userEvent.click(screen.getByRole('button', { name: en.sweep.entities.moreActions }));
      await userEvent.click(await screen.findByRole('menuitem', { name: tp.erase.button }));
      await userEvent.type(screen.getByLabelText(tp.erase.prompt.replace('{name}', 'Ada Lovelace')), 'Ada Lovelace');
      await userEvent.click(screen.getByRole('button', { name: tp.erase.confirm }));
      expect(state.toast.error).toHaveBeenCalledWith(tp.erase.failed);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('says so for a person who does not exist (or was erased)', () => {
    state.profile = failed(new ApiError('Not found', 404));
    renderPanel();
    expect(screen.getByText(tp.notFound)).toBeTruthy();
  });

  it('offers a retry on another failure', async () => {
    state.profile = failed(new ApiError('boom', 500));
    renderPanel();
    expect(screen.getByText(tp.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.profile.refetch).toHaveBeenCalled();
  });

  it('copes with a person who has no properties, activity or recordings to watch', async () => {
    state.profile = ok(makeProfile({ person: { ...makeProfile().person, properties: {}, anonIds: [] }, sessions: [makeSession({ hasRecording: false })], recentEvents: [] }));
    renderPanel();
    expect(screen.getByText(tp.noProperties)).toBeTruthy();
    expect(screen.getByText(tp.noAnonIds)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.activity }));
    expect(screen.getByText(tp.noActivity)).toBeTruthy();
  });
});
