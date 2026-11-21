import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import type { ProfileData } from '@/components/settings';

const state = vi.hoisted(() => ({
  profile: undefined as Record<string, string> | undefined,
  isPending: false,
  isError: false,
  avatar: undefined as string | undefined,
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/hooks/queries/use-self-profile-queries', () => ({
  useSelfProfile: () => ({ data: state.profile, isPending: state.isPending, isError: state.isError }),
  useUpdateSelfProfile: () => ({ mutateAsync: state.updateProfile, isPending: false }),
  useUploadSelfAvatar: () => ({ mutateAsync: state.uploadAvatar, isPending: false }),
}));
vi.mock('@/hooks/use-member-avatar', () => ({ useCurrentUserAvatar: () => state.avatar }));
vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));
vi.mock('@/lib/timezones', () => ({ getBrowserTimezone: () => 'Europe/Amsterdam' }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      settings: {
        profile: {
          messages: {
            loadFailed: 'load failed',
            updateSuccess: 'saved',
            updateFailed: 'save failed',
            avatarSuccess: 'avatar saved',
            avatarFailed: 'avatar failed',
          },
        },
      },
    },
  }),
}));
// The working hours card below the profile has its own tests.
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkingHours: () => ({ data: undefined, isLoading: false }),
  useUpdateWorkingHours: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/components/working-hours/working-hours-editor', () => ({ WorkingHoursEditor: () => null, DEFAULT_HOURS: {} }));
// The form itself has its own tests; this stub exposes what the page hands it.
vi.mock('@/components/settings', () => ({
  ProfileSection: (props: {
    profileData: ProfileData;
    profileChanged: boolean;
    onProfileChange: (field: keyof ProfileData, value: string) => void;
    onProfileSave: () => void;
    onProfileCancel: () => void;
    onAvatarUpload: (e: ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <div>
      <output data-testid="name">{props.profileData.name}</output>
      <output data-testid="timezone">{props.profileData.timezone}</output>
      <output data-testid="avatar">{props.profileData.avatar}</output>
      <output data-testid="changed">{String(props.profileChanged)}</output>
      <button type="button" onClick={() => props.onProfileChange('name', '  Ada King  ')}>rename</button>
      <button type="button" onClick={() => props.onProfileChange('name', '   ')}>clear name</button>
      <button type="button" onClick={props.onProfileSave}>save</button>
      <button type="button" onClick={props.onProfileCancel}>cancel</button>
      <input data-testid="file" type="file" onChange={props.onAvatarUpload} />
    </div>
  ),
}));

import SettingsProfilePage from './page';

const profile = {
  id: 'wm_1',
  email: 'ada@acme.test',
  name: 'Ada Lovelace',
  nickname: 'ada',
  picture: 'https://cdn.test/avatars/ada_1.png',
  phone: ' +31  6 1234 5678 ',
  company: '',
  jobTitle: 'Engineer',
  bio: '',
  timezone: 'UTC',
};

function pickFile(name = 'me.png') {
  const file = new File(['png-bytes'], name, { type: 'image/png' });
  fireEvent.change(screen.getByTestId('file'), { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = { ...profile };
  state.isPending = false;
  state.isError = false;
  state.avatar = 'https://cdn.test/avatars/ada_1.png';
});

describe('SettingsProfilePage', () => {
  it('shows a loader until the profile arrives', () => {
    state.profile = undefined;
    state.isPending = true;
    render(<SettingsProfilePage />);
    expect(screen.queryByTestId('name')).toBeNull();
  });

  it('fills the form from the profile and offers to save the browser timezone over the UTC default', async () => {
    render(<SettingsProfilePage />);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Ada Lovelace'));
    expect(screen.getByTestId('timezone')).toHaveTextContent('Europe/Amsterdam');
    expect(screen.getByTestId('changed')).toHaveTextContent('true');
  });

  it('shows the same avatar as the rest of the app', async () => {
    state.avatar = 'https://cdn.test/avatars/ada_9.png';
    render(<SettingsProfilePage />);
    await waitFor(() => expect(screen.getByTestId('avatar')).toHaveTextContent('https://cdn.test/avatars/ada_9.png'));
  });

  it('keeps what the user typed when the profile is refetched', async () => {
    const { rerender } = render(<SettingsProfilePage />);
    fireEvent.click(await screen.findByText('rename'));
    state.profile = { ...profile, name: 'Someone Else' };
    rerender(<SettingsProfilePage />);
    expect(screen.getByTestId('name')).toHaveTextContent('Ada King');
  });

  it('saves the trimmed name, the tidied phone and the timezone', async () => {
    state.updateProfile.mockResolvedValue({ ...profile, name: 'Ada King' });
    render(<SettingsProfilePage />);
    fireEvent.click(await screen.findByText('rename'));
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('saved'));
    expect(state.updateProfile).toHaveBeenCalledWith({
      name: 'Ada King',
      nickname: 'ada',
      phone: '+31 6 1234 5678',
      jobTitle: 'Engineer',
      bio: '',
      timezone: 'Europe/Amsterdam',
    });
    expect(screen.getByTestId('changed')).toHaveTextContent('false');
  });

  it('does not save an invalid profile', async () => {
    render(<SettingsProfilePage />);
    fireEvent.click(await screen.findByText('clear name'));
    fireEvent.click(screen.getByText('save'));
    expect(state.updateProfile).not.toHaveBeenCalled();
  });

  it('says so when saving fails', async () => {
    state.updateProfile.mockRejectedValue(new Error('500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<SettingsProfilePage />);
    fireEvent.click(await screen.findByText('save'));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('save failed'));
  });

  it('cancel drops the unsaved flag', async () => {
    render(<SettingsProfilePage />);
    fireEvent.click(await screen.findByText('cancel'));
    expect(screen.getByTestId('changed')).toHaveTextContent('false');
  });

  it('uploads a picked picture as a data URL and shows it', async () => {
    state.avatar = undefined;
    state.uploadAvatar.mockResolvedValue('https://cdn.test/avatars/ada_2.png');
    render(<SettingsProfilePage />);
    await screen.findByTestId('file');
    pickFile();

    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('avatar saved'));
    expect(state.uploadAvatar).toHaveBeenCalledWith({
      file: expect.stringMatching(/^data:image\/png;base64,/),
      fileName: 'me.png',
      contentType: 'image/png',
    });
    expect(screen.getByTestId('avatar')).toHaveTextContent('https://cdn.test/avatars/ada_2.png');
  });

  it('says so when the upload returns no picture or fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.uploadAvatar.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('413'));
    render(<SettingsProfilePage />);
    await screen.findByTestId('file');

    pickFile();
    await waitFor(() => expect(state.toastError).toHaveBeenCalledTimes(1));
    pickFile('again.png');
    await waitFor(() => expect(state.toastError).toHaveBeenCalledTimes(2));
    expect(state.toastError).toHaveBeenNthCalledWith(2, 'avatar failed');
  });

  it('ignores an empty file pick', async () => {
    render(<SettingsProfilePage />);
    fireEvent.change(await screen.findByTestId('file'), { target: { files: [] } });
    expect(state.uploadAvatar).not.toHaveBeenCalled();
  });

  it('says so when the profile cannot be loaded', async () => {
    state.profile = undefined;
    state.isError = true;
    render(<SettingsProfilePage />);
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('load failed'));
  });
});
