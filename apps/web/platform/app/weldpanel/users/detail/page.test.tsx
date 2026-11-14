import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { resetCurrentProjectChoice } from '../../lib/use-current-project';
import { makeProfile, makeSession } from '../../observe-fixtures';
import { makeProject } from '../../test-fixtures';
import UserProfilePage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_people:read', 'panel_people:delete', 'panel_recordings:read']),
  profile: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn() },
  erase: vi.fn(),
  push: vi.fn(),
  crmInstalled: true,
  crm: { data: undefined as unknown },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ distinctId: 'user_42' }) }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.crmInstalled, isLoading: false }) }));
vi.mock('@/components/objects/person/use-person-data', () => ({ usePersonSearch: () => state.crm }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelPerson: () => state.profile,
  useEraseWeldPanelPerson: () => ({ mutateAsync: state.erase, isPending: false }),
}));

const tp = en.weldpanel.observe.person;
const ok = (data = makeProfile()) => ({ data, isLoading: false, error: null, refetch: vi.fn() });

describe('User profile', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_people:read', 'panel_people:delete', 'panel_recordings:read']);
    state.profile = ok();
    state.erase.mockReset();
    state.push.mockReset();
    state.toast.success.mockReset();
    state.toast.error.mockReset();
    state.crmInstalled = true;
    state.crm = { data: undefined };
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('shows the person, their numbers and properties', () => {
    render(<UserProfilePage />);
    expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeTruthy();
    expect(screen.getByText('321')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('pro')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('lists the activity timeline', async () => {
    render(<UserProfilePage />);
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.activity }));
    expect(screen.getByText('Signed up')).toBeTruthy();
    expect(screen.getByText('$pageview')).toBeTruthy();
  });

  it('links to the person recordings, filtered to them', async () => {
    render(<UserProfilePage />);
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.recordings }));
    const href = screen.getByRole('link', { name: tp.allRecordings }).getAttribute('href')!;
    expect(href).toContain('/weldpanel/recordings?');
    expect(href).toContain('user=user_42');
    expect(href).toContain('project=wpp_1');
    expect(screen.getByRole('link', { name: tp.watch }).getAttribute('href')).toBe('/weldpanel/recordings/ses_1?project=wpp_1');
  });

  it('hides recordings from people who may not watch them', async () => {
    state.perms = new Set(['panel_people:read']);
    render(<UserProfilePage />);
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.recordings }));
    expect(screen.queryByRole('link', { name: tp.allRecordings })).toBeNull();
    expect(screen.queryByRole('link', { name: tp.watch })).toBeNull();
  });

  describe('Open in WeldCRM', () => {
    it('appears when a CRM person has the same email', () => {
      state.crm = { data: { data: [{ id: 'per_9', email: 'ADA@example.com' }] } };
      render(<UserProfilePage />);
      expect(screen.getByRole('link', { name: tp.openInCrm }).getAttribute('href')).toBe('/weldcrm/people/per_9');
    });

    it('stays away when the email matches nobody, or WeldCRM is not installed', () => {
      state.crm = { data: { data: [{ id: 'per_9', email: 'someone@else.com' }] } };
      const { unmount } = render(<UserProfilePage />);
      expect(screen.queryByRole('link', { name: tp.openInCrm })).toBeNull();
      unmount();
      state.crmInstalled = false;
      state.crm = { data: { data: [{ id: 'per_9', email: 'ada@example.com' }] } };
      render(<UserProfilePage />);
      expect(screen.queryByRole('link', { name: tp.openInCrm })).toBeNull();
    });
  });

  describe('erasure', () => {
    it('is only offered with the delete permission', () => {
      state.perms = new Set(['panel_people:read']);
      render(<UserProfilePage />);
      expect(screen.queryByRole('button', { name: tp.erase.button })).toBeNull();
    });

    it('needs the name typed before it erases', async () => {
      state.erase.mockResolvedValue({ userId: 'user_42', erasedIdCount: 3, recordingChunksDeleted: 12 });
      render(<UserProfilePage />);
      await userEvent.click(screen.getByRole('button', { name: tp.erase.button }));
      const confirm = screen.getByRole('button', { name: tp.erase.confirm });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      await userEvent.type(screen.getByLabelText(tp.erase.prompt.replace('{name}', 'Ada Lovelace')), 'Ada Lovelace');
      await userEvent.click(confirm);
      expect(state.erase).toHaveBeenCalledWith('user_42');
      expect(state.toast.success).toHaveBeenCalledWith('Erased. 3 ids excluded, 12 recording chunks deleted.');
      expect(state.push).toHaveBeenCalledWith('/weldpanel/users');
    });

    it('stays on the profile when the erasure fails', async () => {
      state.erase.mockRejectedValue(new Error('boom'));
      render(<UserProfilePage />);
      await userEvent.click(screen.getByRole('button', { name: tp.erase.button }));
      await userEvent.type(screen.getByLabelText(tp.erase.prompt.replace('{name}', 'Ada Lovelace')), 'Ada Lovelace');
      await userEvent.click(screen.getByRole('button', { name: tp.erase.confirm }));
      expect(state.toast.error).toHaveBeenCalledWith(tp.erase.failed);
      expect(state.push).not.toHaveBeenCalled();
    });
  });

  it('says so for a person who does not exist (or was erased)', () => {
    state.profile = { data: undefined, isLoading: false, error: new ApiError('Not found', 404), refetch: vi.fn() };
    render(<UserProfilePage />);
    expect(screen.getByText(tp.notFound)).toBeTruthy();
  });

  it('offers a retry on another failure', async () => {
    state.profile = { data: undefined, isLoading: false, error: new ApiError('boom', 500), refetch: vi.fn() };
    render(<UserProfilePage />);
    expect(screen.getByText(tp.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.profile.refetch).toHaveBeenCalled();
  });

  it('copes with a person who has no properties or sessions', async () => {
    state.profile = ok(makeProfile({ person: { ...makeProfile().person, properties: {}, anonIds: [] }, sessions: [makeSession({ hasRecording: false })], recentEvents: [] }));
    render(<UserProfilePage />);
    expect(screen.getByText(tp.noProperties)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: tp.tabs.activity }));
    expect(screen.getByText(tp.noActivity)).toBeTruthy();
  });
});
