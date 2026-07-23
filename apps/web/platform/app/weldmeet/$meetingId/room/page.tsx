import { useParams, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useWeldMeetCall } from '@/contexts/weldmeet-call-context';
import { useMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useAuth } from '@clerk/clerk-react';
import { getTranslations } from '@/lib/i18n';
// Lazy + dynamic-only: app-shell also dynamically imports meeting-overlay
// (for MeetingOverlay). Importing InlineMeetingView statically here made the
// module a mixed static+dynamic import, which the CI build folds into a route
// chunk and breaks app-shell's lazy import(). Keeping both imports dynamic
// gives meeting-overlay one stable chunk.
const InlineMeetingView = lazy(() =>
  import('@/app/weldmeet/components/meeting-overlay').then((m) => ({ default: m.InlineMeetingView })),
);

export default function MeetingRoomPage() {
  const t = getTranslations('weldmeet');
  const { meetingId } = useParams({ from: '/weldmeet/$meetingId/room' });
  const navigate = useNavigate();
  const { status, joinMeeting } = useWeldMeetCall();
  const { data: meeting } = useMeeting(meetingId);
  const { userId } = useAuth();
  const hasJoined = useRef(false);

  // Auto-join on mount / reload
  useEffect(() => {
    if (status === 'idle' && meeting && !hasJoined.current) {
      hasJoined.current = true;
      const isOrganizer = meeting.organizerId === userId;
      joinMeeting(meetingId, {
        meetingType: meeting.meetingType as 'video' | 'audio',
        title: meeting.title,
        isOrganizer,
        skipPreview: isOrganizer,
      });
    }
  }, [status, meeting, meetingId, joinMeeting, userId]);

  // Navigate away when meeting ends
  useEffect(() => {
    if (status === 'idle' && hasJoined.current) {
      navigate({ to: '/weldmeet/$meetingId', params: { meetingId } });
    }
  }, [status, navigate]);

  if (status !== 'idle' && status !== 'ended') {
    return (
      <div className="flex flex-col h-full">
        <Suspense fallback={null}>
          <InlineMeetingView />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t.meetingRoomPage.preparingRoom}</p>
      </div>
    </div>
  );
}
