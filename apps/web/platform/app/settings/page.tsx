
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ProfileSection, type ProfileData } from '@/components/settings';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { WorkingHoursEditor, DEFAULT_HOURS } from '@/components/working-hours/working-hours-editor';
import {
  useWorkingHours,
  useUpdateWorkingHours,
  type WorkingHours,
} from '@/hooks/queries/use-settings-queries';
import {
  useSelfProfile,
  useUpdateSelfProfile,
  useUploadSelfAvatar,
} from '@/hooks/queries/use-self-profile-queries';
import { useCurrentUserAvatar } from '@/hooks/use-member-avatar';
import { useI18n } from '@/lib/i18n/provider';
import { toast } from 'sonner';
import { getBrowserTimezone } from '@/lib/timezones';
import {
  hasProfileErrors,
  normalizePhone,
  resolveProfileTimezone,
  validateProfile,
} from '@/lib/profile-validation';

const EMPTY_PROFILE: ProfileData = {
  name: '',
  email: '',
  nickname: '',
  phone: '',
  jobTitle: '',
  bio: '',
  timezone: 'UTC',
  avatar: '',
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SettingsProfilePage() {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [profileData, setProfileData] = React.useState<ProfileData>(EMPTY_PROFILE);
  const [profileChanged, setProfileChanged] = React.useState(false);
  const { t } = useI18n();
  const ts = t.settings.profile;

  // The profile is shared with the rest of the app (it is where your avatar
  // everywhere comes from), so saves and uploads go through its cache.
  const { data: profile, isPending, isError } = useSelfProfile();
  const updateProfile = useUpdateSelfProfile();
  const uploadAvatar = useUploadSelfAvatar();
  // The same picture the sidebar, your messages and your teammates show.
  const avatar = useCurrentUserAvatar();
  const saving = updateProfile.isPending || uploadAvatar.isPending;

  // Fill the form from the first profile that arrives; a later refetch must
  // not overwrite what the user is typing.
  const formFilled = React.useRef(false);
  React.useEffect(() => {
    if (!profile || formFilled.current) return;
    formFilled.current = true;
    // 'UTC' is the API's untouched default, not a choice: show the
    // browser's zone instead (and offer Save, so it is persisted).
    const tz = resolveProfileTimezone(profile.timezone, getBrowserTimezone());
    setProfileData({
      name: profile.name || '',
      email: profile.email || '',
      nickname: profile.nickname || '',
      phone: profile.phone || '',
      jobTitle: profile.jobTitle || '',
      bio: profile.bio || '',
      timezone: tz.timezone,
      avatar: profile.picture || '',
    });
    if (tz.prefilled) setProfileChanged(true);
  }, [profile]);

  React.useEffect(() => {
    if (isError) toast.error(ts.messages.loadFailed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failed load; ts.messages.loadFailed shouldn't re-toast on locale change.
  }, [isError]);

  const handleProfileChange = (field: string, value: string) => {
    setProfileData(prev => ({
      ...prev,
      [field]: value,
    }));
    setProfileChanged(true);
  };

  const handleProfileSave = async () => {
    if (hasProfileErrors(validateProfile(profileData))) return;
    try {
      await updateProfile.mutateAsync({
        name: profileData.name.trim(),
        nickname: profileData.nickname,
        phone: normalizePhone(profileData.phone),
        jobTitle: profileData.jobTitle,
        bio: profileData.bio,
        // The Timezone picker enables Save, so it has to be sent — omitting it
        // silently discarded the edit while still toasting success.
        timezone: profileData.timezone,
      });
      toast.success(ts.messages.updateSuccess);
      setProfileChanged(false);
    } catch (error) {
      console.error('Error saving profile:', error);
      toast.error(ts.messages.updateFailed);
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    try {
      // The API takes the image as a base64 data URL.
      const imageUrl = await uploadAvatar.mutateAsync({
        file: await readAsDataUrl(file),
        fileName: file.name,
        contentType: file.type,
      });
      if (imageUrl) {
        setProfileData(prev => ({ ...prev, avatar: imageUrl }));
        toast.success(ts.messages.avatarSuccess);
      } else {
        toast.error(ts.messages.avatarFailed);
      }
    } catch (error) {
      console.error('Error uploading avatar:', error);
      toast.error(ts.messages.avatarFailed);
    } finally {
      input.value = '';
    }
  };

  if (isPending) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="space-y-12">
      <ProfileSection
        profileData={{ ...profileData, avatar: avatar ?? profileData.avatar }}
        profileChanged={profileChanged}
        loading={saving}
        fileInputRef={fileInputRef}
        onProfileChange={handleProfileChange}
        onProfileSave={handleProfileSave}
        onProfileCancel={() => setProfileChanged(false)}
        onAvatarUpload={handleAvatarUpload}
      />
      <hr className="border-border" />
      <WorkingHoursCard />
    </div>
  );
}

function WorkingHoursCard() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canEditSelf = can('working-hours:edit-self') || can('team:update');

  const { data: workingHours, isLoading } = useWorkingHours();
  const updateMutation = useUpdateWorkingHours();

  const [hours, setHours] = React.useState<WorkingHours>(DEFAULT_HOURS);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (workingHours) setHours(workingHours);
  }, [workingHours]);

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = (next: WorkingHours) => {
    setHours(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await updateMutation.mutateAsync(next);
      } catch {
        toast.error(t('sweep.settings.workingHours.updateFailed'));
      }
    }, 500);
  };

  return (
    <Card className="border-0 shadow-none bg-transparent py-0 gap-0">
      <CardHeader className="px-0">
        <CardTitle>{t('sweep.settings.workingHours.title')}</CardTitle>
        <CardDescription>
          {t('sweep.settings.workingHours.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <PageLoader fullScreen={false} />
        ) : (
          <>
            {!canEditSelf && (
              <p className="text-sm text-muted-foreground mb-4">
                {t('sweep.settings.workingHours.locked')}
              </p>
            )}
            <WorkingHoursEditor
              value={hours}
              onChange={handleChange}
              disabled={!canEditSelf}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
