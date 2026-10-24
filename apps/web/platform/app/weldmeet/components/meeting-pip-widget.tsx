import { useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { usePathname } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { useWeldMeetCall } from '@/contexts/weldmeet-call-context';
import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { useMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { MinimizedCallWidget, type MinimizedCallWidgetLabels } from '@/components/call';

/**
 * The minimized meeting: the shared <MinimizedCallWidget/> fed by the WeldMeet
 * call context. WeldChat calls render the same widget
 * (app/weldchat/components/pip-call-widget.tsx).
 */
export function MeetingPiPWidget() {
  const {
    status,
    meetingId,
    duration,
    isMuted,
    isVideoOff,
    isScreenSharing,
    handRaised,
    isFullscreen,
    isPiP,
    meeting,
    meetingTitle,
    prewarmedVideoTrack,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    leaveMeeting,
    expandFromPiP,
    registerPopOut,
  } = useWeldMeetCall();

  const navigate = useNavigate();
  const pathname = usePathname();
  const t = getTranslations('weldmeet');

  // Both minimized widgets live in the shell, but only this one claims the
  // browser's auto-PiP. A WeldChat call keeps the camera/mic busy, which is
  // all Chrome needs to fire that handler on a tab switch, so it would pop a
  // browser window for the chat call. Chat calls stay in the in-app widget.
  const chatCallStatus = useWeldChatCallOptional()?.status;
  const isChatCallActive = !!chatCallStatus && !['idle', 'ended', 'ringing-incoming'].includes(chatCallStatus);

  const isOnMeetingPage = !!meetingId && pathname?.startsWith(`/weldmeet/${meetingId}`);
  const shouldShow = status === 'connected' && !isFullscreen && (isPiP || !isOnMeetingPage);
  // The room view (and its per-tile <audio>) is mounted only on the /room page
  // or in the fullscreen overlay; everywhere else this widget plays the call.
  const isRoomMounted = isFullscreen || (!!meetingId && pathname?.replace(/\/$/, '') === `/weldmeet/${meetingId}/room`);
  const playsRemoteAudio = status === 'connected' && !isRoomMounted;

  const labels = useMemo<MinimizedCallWidgetLabels>(() => ({
    ...t.pipWidget,
    open: t.pipWidget.openMeeting,
    leave: t.pipWidget.leaveMeeting,
  }), [t]);

  // Joining info (copied from the "More" menu) — mirrors the meeting-overlay
  // share URL: <portal>/<workspace>/<joinCode>.
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const { data: meetingData } = useMeeting(meetingId ?? '');
  const handleCopyJoiningInfo = useCallback(() => {
    const joinCode = meetingData?.joinCode ?? '';
    const shareUrl = buildMeetingShareUrl(workspaceId, joinCode) ?? '';
    const text = [
      t.pipWidget.joiningInfoTitle,
      shareUrl ? `${t.pipWidget.joiningInfoJoin}: ${shareUrl}` : null,
      joinCode ? `${t.pipWidget.joiningInfoMeetingId}: ${joinCode}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t.pipWidget.joiningInfoCopied))
      .catch(() => {});
  }, [meetingData?.joinCode, workspaceId, t]);

  const handleExpand = useCallback(() => {
    expandFromPiP();
    if (meetingId) {
      void navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId } });
    }
  }, [expandFromPiP, navigate, meetingId]);

  const handleLeave = useCallback(() => {
    void leaveMeeting();
  }, [leaveMeeting]);

  return (
    <MinimizedCallWidget
      status={status}
      meeting={meeting}
      title={meetingTitle}
      appName="WeldMeet"
      duration={duration}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      isScreenSharing={isScreenSharing}
      handRaised={handRaised}
      shouldShow={shouldShow}
      playsRemoteAudio={playsRemoteAudio}
      labels={labels}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
      toggleHandRaise={toggleHandRaise}
      onLeave={handleLeave}
      onExpand={handleExpand}
      onPopOutClosed={expandFromPiP}
      onCopyJoiningInfo={handleCopyJoiningInfo}
      registerPopOut={registerPopOut}
      autoPictureInPicture={!isChatCallActive}
      autoPictureInPicturePathPrefix="/weldmeet"
      prewarmedVideoTrack={prewarmedVideoTrack}
    />
  );
}
