import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  tab: undefined as string | undefined,
  navigate: vi.fn(),
  settings: { data: undefined as unknown, isLoading: false },
  timezones: { data: undefined as unknown },
  updateSettings: vi.fn(),
  team: { data: undefined as unknown, isLoading: false },
  createMember: vi.fn(),
  updateMember: vi.fn(),
  deleteMember: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ tab: m.tab }),
  useNavigate: () => m.navigate,
}));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
// The EU edition's PostPeer notice reads its own query (covered in settings/outside-eu).
vi.mock('@/components/outside-eu/outside-eu-notice', () => ({ OutsideEuNotice: () => null }));
vi.mock('@/hooks/queries/use-social-queries', () => ({
  useSocialSettings: () => m.settings,
  useSocialTimezones: () => m.timezones,
  useUpdateSocialSettings: () => ({ mutateAsync: m.updateSettings, isPending: false }),
  useSocialTeam: () => m.team,
  useCreateSocialTeamMember: () => ({ mutateAsync: m.createMember, isPending: false }),
  useUpdateSocialTeamMember: () => ({ mutateAsync: m.updateMember, isPending: false }),
  useDeleteSocialTeamMember: () => ({ mutate: m.deleteMember, isPending: false }),
}));
// Radix Select needs pointer APIs jsdom lacks: use a native select with the same props.
vi.mock('@weldsuite/ui/components/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ value?: string; onValueChange?: (v: string) => void }>({});
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <select aria-label="select" value={ctx.value ?? ''} onChange={(e) => ctx.onValueChange?.(e.target.value)}>
          <option value="" />
          {children}
        </select>
      );
    },
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  };
});

import WeldSocialSettingsPage from './page';
import { SocialGeneralSettings } from './general-section';
import { SocialTeamSettings } from './team-section';

const ts = en.social;

describe('WeldSocial settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.tab = undefined;
    m.settings = { data: { data: {} }, isLoading: false };
    m.timezones = { data: { data: [] } };
    m.team = { data: { data: [] }, isLoading: false };
  });

  it('opens on the general tab and navigates to the team tab', async () => {
    render(<WeldSocialSettingsPage />);
    expect(screen.getByText(ts.settings.general)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /team/i }));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/settings/apps/social', search: { tab: 'team' } });
  });

  it('drops the search param when going back to general', async () => {
    m.tab = 'team';
    render(<WeldSocialSettingsPage />);
    expect(screen.getByText(ts.team.inviteMember)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /general/i }));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/settings/apps/social', search: {} });
  });

  it('falls back to general for an unknown tab', () => {
    m.tab = 'bogus';
    render(<WeldSocialSettingsPage />);
    expect(screen.getByText(ts.settings.general)).toBeTruthy();
  });
});

describe('WeldSocial general settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.settings = {
      data: { data: { defaultTimezone: 'Europe/Amsterdam', defaultApprovalRequired: true, autoScheduleEnabled: false, hashtagSuggestions: true, linkShortening: false } },
      isLoading: false,
    };
    m.timezones = { data: { data: ['Europe/Amsterdam', 'America/New_York'] } };
    m.updateSettings.mockResolvedValue({});
  });

  it('shows a spinner while loading', () => {
    m.settings = { data: undefined, isLoading: true };
    render(<SocialGeneralSettings />);
    expect(screen.queryByText(ts.settings.general)).toBeNull();
  });

  it('loads the saved defaults into the form', async () => {
    render(<SocialGeneralSettings />);
    await waitFor(() => expect(screen.getByLabelText(ts.settings.requireApproval).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByLabelText(ts.settings.autoPublish).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByLabelText('sweep.miscA.socialSettings.hashtagSuggestions').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('select') as HTMLSelectElement).value).toBe('Europe/Amsterdam');
  });

  it('saves the changed timezone and checkboxes and toasts', async () => {
    render(<SocialGeneralSettings />);
    await waitFor(() => expect(screen.getByLabelText(ts.settings.requireApproval).getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(screen.getByLabelText('select'), { target: { value: 'America/New_York' } });
    await userEvent.click(screen.getByLabelText(ts.settings.autoPublish));
    await userEvent.click(screen.getByLabelText('sweep.miscA.socialSettings.linkShortening'));
    await userEvent.click(screen.getByRole('button', { name: ts.actions.save }));
    await waitFor(() =>
      expect(m.updateSettings).toHaveBeenCalledWith({
        defaultTimezone: 'America/New_York',
        defaultApprovalRequired: true,
        autoScheduleEnabled: true,
        hashtagSuggestions: true,
        linkShortening: true,
      }),
    );
    expect(m.toastSuccess).toHaveBeenCalledWith(ts.messages.settingsSaved);
  });

  it('toasts the failure with its detail when saving fails', async () => {
    m.updateSettings.mockRejectedValue(new Error('server said no'));
    render(<SocialGeneralSettings />);
    await userEvent.click(screen.getByRole('button', { name: ts.actions.save }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(ts.messages.settingsSaveFailed, { description: 'server said no' }));
  });
});

describe('WeldSocial team settings', () => {
  const members = [
    { id: 'm1', name: 'Ada', email: 'ada@example.com', role: 'admin' },
    { id: 'm2', name: '', email: 'bob@example.com', role: 'viewer' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    m.team = { data: { data: members }, isLoading: false };
    m.createMember.mockResolvedValue({});
    m.updateMember.mockResolvedValue({});
  });

  it('shows a spinner while loading', () => {
    m.team = { data: undefined, isLoading: true };
    render(<SocialTeamSettings />);
    expect(screen.queryByText(ts.team.title)).toBeNull();
  });

  it('shows the empty state', () => {
    m.team = { data: { data: [] }, isLoading: false };
    render(<SocialTeamSettings />);
    expect(screen.getByText(ts.team.noTeamMembers)).toBeTruthy();
  });

  it('lists members with their role', () => {
    render(<SocialTeamSettings />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('bob@example.com')).toBeTruthy();
    expect(screen.getByText(ts.team.roles.admin)).toBeTruthy();
    expect(screen.getByText(ts.team.roles.viewer)).toBeTruthy();
  });

  it('invites a member with the chosen role', async () => {
    render(<SocialTeamSettings />);
    await userEvent.click(screen.getByRole('button', { name: ts.team.inviteMember }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: ts.actions.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const [name, email] = within(dialog).getAllByRole('textbox');
    await userEvent.type(name!, 'Cleo');
    await userEvent.type(email!, 'cleo@example.com');
    expect(save.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('select'), { target: { value: 'manager' } });
    await userEvent.click(save);
    await waitFor(() => expect(m.createMember).toHaveBeenCalledWith({ email: 'cleo@example.com', name: 'Cleo', role: 'manager' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits a member: the email is locked and the update carries the id', async () => {
    render(<SocialTeamSettings />);
    const card = screen.getByText('Ada').closest('[data-slot="card"]') as HTMLElement;
    await userEvent.click(within(card).getAllByRole('button')[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ts.team.changeRole)).toBeTruthy();
    const [, email] = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
    expect(email!.disabled).toBe(true);
    expect(email!.value).toBe('ada@example.com');
    fireEvent.change(within(dialog).getByLabelText('select'), { target: { value: 'editor' } });
    await userEvent.click(within(dialog).getByRole('button', { name: ts.actions.save }));
    await waitFor(() => expect(m.updateMember).toHaveBeenCalledWith({ id: 'm1', email: 'ada@example.com', name: 'Ada', role: 'editor' }));
  });

  it('keeps the dialog open and toasts when saving fails', async () => {
    m.createMember.mockRejectedValue(new Error('dup'));
    render(<SocialTeamSettings />);
    await userEvent.click(screen.getByRole('button', { name: ts.team.inviteMember }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getAllByRole('textbox')[1]!, 'x@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: ts.actions.save }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(ts.messages.teamMemberSaveFailed, { description: 'dup' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: ts.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('removes a member', async () => {
    render(<SocialTeamSettings />);
    const card = screen.getByText('Ada').closest('[data-slot="card"]') as HTMLElement;
    await userEvent.click(within(card).getAllByRole('button')[1]!);
    expect(m.deleteMember).toHaveBeenCalledWith('m1');
  });
});
