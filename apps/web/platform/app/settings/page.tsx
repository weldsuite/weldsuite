
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { ProfileSection, type ProfileData } from '@/components/settings';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { WorkingHoursEditor, DEFAULT_HOURS } from '@/components/working-hours/working-hours-editor';
import {
  useWorkingHours,
  useUpdateWorkingHours,
  type WorkingHours,
} from '@/hooks/queries/use-settings-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { toast } from 'sonner';

/** Shape returned by GET|PUT /api/settings/profile. */
interface SelfProfileResponse {
  id: string;
  email: string;
  name: string;
  nickname: string;
  picture: string;
  phone: string;
  company: string;
  jobTitle: string;
  bio: string;
  timezone: string;
}

export default function SettingsProfilePage() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [profileData, setProfileData] = React.useState<ProfileData>({
    name: '',
    email: '',
    nickname: '',
    phone: '',
    jobTitle: '',
    bio: '',
    timezone: 'UTC',
    avatar: '',
  });
  const [profileChanged, setProfileChanged] = React.useState(false);
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const ts = t.settings.profile;

  // Load profile on mount
  React.useEffect(() => {
    const loadProfile = async () => {
      try {
        const client = await getClient();
        // app-api answers `{ data }` and throws on non-2xx — reaching this line
        // IS the success signal (there is no `success` flag to branch on).
        const { data } = await client.get<{ data: SelfProfileResponse }>('/settings/profile');
        if (data) {
          setProfileData({
            name: data.name || '',
            email: data.email || '',
            nickname: data.nickname || '',
            phone: data.phone || '',
            jobTitle: data.jobTitle || '',
            bio: data.bio || '',
            timezone: data.timezone || 'UTC',
            avatar: data.picture || '',
          });
        }
      } catch (error) {
        console.error('Failed to load profile:', error);
        toast.error(ts.messages.loadFailed);
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only profile load; ts.messages.loadFailed shouldn't trigger a refetch on locale change.
  }, [getClient]);

  const handleProfileChange = (field: string, value: string) => {
    setProfileData(prev => ({
      ...prev,
      [field]: value,
    }));
    setProfileChanged(true);
  };

  const handleProfileSave = async () => {
    setSaving(true);
    try {
      const client = await getClient();
      const updateData = {
        name: profileData.name,
        nickname: profileData.nickname,
        phone: profileData.phone,
        jobTitle: profileData.jobTitle,
        bio: profileData.bio,
        // The Timezone picker enables Save, so it has to be sent — omitting it
        // silently discarded the edit while still toasting success.
        timezone: profileData.timezone,
      };
      await client.put<{ data: SelfProfileResponse }>('/settings/profile', updateData);
      toast.success(ts.messages.updateSuccess);
      setProfileChanged(false);
    } catch (error) {
      console.error('Error saving profile:', error);
      toast.error(ts.messages.updateFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setSaving(true);
    try {
      const client = await getClient();
      // Convert file to base64 for API transport
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { data } = await client.put<{ data: { imageUrl: string } }>('/settings/profile/avatar', {
        file: base64,
        fileName: file.name,
        contentType: file.type,
      });
      if (data?.imageUrl) {
        setProfileData(prev => ({ ...prev, avatar: data.imageUrl }));
        toast.success(ts.messages.avatarSuccess);
      } else {
        toast.error(ts.messages.avatarFailed);
      }
    } catch (error) {
      console.error('Error uploading avatar:', error);
      toast.error(ts.messages.avatarFailed);
    } finally {
      setSaving(false);
      event.target.value = '';
    }
  };

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="space-y-12">
      <ProfileSection
        profileData={profileData}
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
