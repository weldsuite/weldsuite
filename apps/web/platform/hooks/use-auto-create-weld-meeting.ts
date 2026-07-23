import { useAuth } from '@clerk/clerk-react';
import { useCreateMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { toast } from 'sonner';

export function useAutoCreateWeldMeeting() {
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
      // app-api create returns { id } only — fetch the full meeting to get joinCode
      const client = await getClient();
      const meetingRes = await client.get<{ data: { joinCode: string } }>(`/meetings/${created.id}`);
      const joinCode = meetingRes.data?.joinCode;
      const meetingPortalUrl = import.meta.env.VITE_MEETING_PORTAL_URL || window.location.origin;
      const url = `${meetingPortalUrl}/${workspaceId}/${joinCode}`;
      return { url, meetingId: created.id };
    } catch (err: any) {
      toast.error('Failed to create WeldMeet link', {
        description: err?.response?.data?.error || err?.message || 'Please try again.',
      });
      return null;
    }
  };

  return {
    createMeetingAndGetUrl,
    isPending: createMeeting.isPending,
  };
}
