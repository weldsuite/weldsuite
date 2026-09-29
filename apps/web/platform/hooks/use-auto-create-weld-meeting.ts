import { useAuth } from '@clerk/clerk-react';
import { useCreateMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { getTranslations } from '@/lib/i18n';
import { toast } from 'sonner';

export function useAutoCreateWeldMeeting() {
  const t = getTranslations('weldmeet');
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const createMeeting = useCreateMeeting();
  const { getClient } = useAppApiClient();

  const createMeetingAndGetUrl = async (title?: string): Promise<{ url: string; meetingId: string } | null> => {
    try {
      const created = await createMeeting.mutateAsync({
        title: title || 'Meeting',
        meetingType: 'video',
        accessType: 'anyone_with_link',
        waitingRoom: true,
      });
      // The create response carries the join code; fall back to fetching the
      // meeting for an API that predates that.
      let code = created.joinCode;
      if (!code) {
        const client = await getClient();
        const meetingRes = await client.get<{ data: { joinCode: string | null } }>(`/meetings/${created.id}`);
        code = meetingRes.data?.joinCode ?? '';
      }
      const url = buildMeetingShareUrl(workspaceId, code);
      if (!url) {
        // Never hand back a link that cannot work (e.g. ".../null").
        toast.error(t.newMeetingPage.meetingLinkUnavailable, {
          description: t.newMeetingPage.meetingLinkUnavailableHint,
        });
        return null;
      }
      return { url, meetingId: created.id };
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error('Failed to create WeldMeet link', {
        description: e?.response?.data?.error || e?.message || 'Please try again.',
      });
      return null;
    }
  };

  return {
    createMeetingAndGetUrl,
    isPending: createMeeting.isPending,
  };
}
