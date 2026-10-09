import { useParams, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useWeldMeetCall } from '@/contexts/weldmeet-call-context';
import { useMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useAuth } from '@clerk/clerk-react';
import { getTranslations } from '@/lib/i18n';
import { peekStartHandoff } from '@/lib/weldmeet/start-handoff';
import { useOptionalBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useCallSwitchOptional, useOtherActiveCall } from '@/contexts/active-call-context';
import { meetingCallLabel } from '@/lib/call-switch-labels';
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
  const { status, joinMeeting, cancelPreview, meetingId: callMeetingId } = useWeldMeetCall();
  const { data: meeting } = useMeeting(meetingId);
  const { userId } = useAuth();
  // A user is in at most one call or meeting: joining this room while another
  // call (a different meeting, or a WeldChat call) is live asks first.
  const otherCall = useOtherActiveCall({ kind: 'meet', id: meetingId });
  const otherCallKey = otherCall ? `${otherCall.kind}:${otherCall.id}` : null;
  const { requestSwitch } = useCallSwitchOptional();
  const meetingTitle = meeting?.id === meetingId ? meeting.title : null;
  // The page we came from (e.g. "New Meeting") must not stay in the header.
  useOptionalBreadcrumbs(meeting ? [{ label: meeting.title }] : []);
  // The meeting this page already started joining. The router reuses this
  // component when only `$meetingId` changes, so a boolean would block the
  // auto-join of the second room.
  const joinedMeetingId = useRef<string | null>(null);
  // The meeting whose call actually left 'idle' (preview, connecting, …).
  // `joinMeeting` only moves the status on a later render, so "idle after we
  // asked to join" is not the end of the call: when the meeting is already
  // cached (Start/Join on the detail page) the auto-join and the navigate-away
  // effects run in the same commit, and the page bounced straight back.
  const activeMeetingId = useRef<string | null>(null);

  // A pre-join preview left over from another meeting would keep the camera
  // on and block the auto-join below (it needs status 'idle'): drop it.
  useEffect(() => {
    if (status === 'preview' && callMeetingId && callMeetingId !== meetingId) {
      cancelPreview();
    }
  }, [status, callMeetingId, meetingId, cancelPreview]);

  // Ask before this room replaces the live call. The camera and microphone stay
  // untouched (the pre-join preview has not started) and the live call keeps
  // running until the user picks "Leave and join"; "Stay" goes back to the
  // meeting's page.
  useEffect(() => {
    // Not once this page has started joining: a call that comes up later (a ring
    // accepted while in this meeting) asks through its own entry point, and the
    // room page must not ask again on its way out.
    if (!otherCallKey || meetingTitle === null || joinedMeetingId.current === meetingId) return;
    return requestSwitch({
      target: { kind: 'meet', label: () => meetingCallLabel(meetingTitle, 'target') },
      except: { kind: 'meet', id: meetingId },
      // Nothing to start here: once the live call is left, the auto-join below takes over.
      proceed: () => undefined,
      onCancel: () => {
        void navigate({ to: '/weldmeet/$meetingId', params: { meetingId } });
      },
    });
  }, [otherCallKey, meetingTitle, meetingId, requestSwitch, navigate]);

  // Auto-join on mount / reload, once no other call is live
  useEffect(() => {
    if (
      status === 'idle' &&
      !otherCallKey &&
      meeting &&
      meeting.id === meetingId &&
      joinedMeetingId.current !== meetingId
    ) {
      joinedMeetingId.current = meetingId;
      const isOrganizer = meeting.organizerId === userId;
      void joinMeeting(meetingId, {
        meetingType: meeting.meetingType as 'video' | 'audio',
        title: meeting.title,
        isOrganizer,
        // The host gets the pre-join screen like everyone else (check mic /
        // camera, pick devices), except right after "Start an instant meeting":
        // that flow already holds a start hand-off and the host is expected to
        // land in the room straight away.
        skipPreview: isOrganizer && peekStartHandoff(meetingId),
      });
    }
  }, [status, otherCallKey, meeting, meetingId, joinMeeting, userId]);

  useEffect(() => {
    if (status !== 'idle' && callMeetingId === meetingId) {
      activeMeetingId.current = meetingId;
    }
  }, [status, callMeetingId, meetingId]);

  // Navigate away when the call ends (left, ended, cancelled or failed)
  useEffect(() => {
    if (status === 'idle' && activeMeetingId.current === meetingId) {
      activeMeetingId.current = null;
      navigate({ to: '/weldmeet/$meetingId', params: { meetingId } });
    }
  }, [status, navigate, meetingId]);

  // This room's own call (preview, connecting or connected). A call that is live
  // for ANOTHER meeting must not show up here: the dialog above is handling it.
  if (status !== 'idle' && status !== 'ended' && callMeetingId === meetingId) {
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
