import { useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useWeldChatCall, useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { useChannel, useChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { useUser } from '@clerk/clerk-react';
import { usePathname } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';
import { MinimizedCallWidget, type MinimizedCallWidgetLabels } from '@/components/call';

/**
 * Outer guard: render nothing when the WeldChatCall provider isn't reachable.
 *
 * This widget is lazy-loaded, so during HMR Vite can re-import it (and a fresh
 * copy of `weldchat-call-context`) while the still-mounted provider holds the
 * previous context instance — `useContext` would then return null and the
 * throwing `useWeldChatCall()` would crash the whole shell. Mirrors the
 * `useWeldChatCallOptional` / `usePresenceMaybe` pattern already used in the
 * context. In production (no HMR) the provider is always reachable, so the
 * inner widget renders exactly as before.
 */
export function PiPCallWidget() {
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  return <PiPCallWidgetInner />;
}

/**
 * Whether the user is currently viewing the call's own conversation.
 * The URL param differs by route shape, so we can't just compare it to channelId:
 *   • 1:1 DM    → /weldchat/dm/$userId          (param is the OTHER user's id)
 *   • group DM  → /weldchat/dm/group/$channelId (param is the channel id)
 *   • channel   → /weldchat/$channelId          (param is the channel id)
 */
function isOnCallConversation(
  pathname: string | null | undefined,
  channelId: string | null | undefined,
  otherMemberUserId: string | null | undefined,
): boolean {
  const groupMatch = pathname?.match(/\/weldchat\/dm\/group\/([^/]+)/);
  if (groupMatch) return groupMatch[1] === channelId;
  const dmMatch = pathname?.match(/\/weldchat\/dm\/([^/]+)/);
  if (dmMatch) return !!otherMemberUserId && dmMatch[1] === otherMemberUserId;
  const channelMatch = pathname?.match(/\/weldchat\/([^/]+)/);
  return !!channelMatch && channelMatch[1] === channelId;
}

/**
 * The minimized chat call: the same <MinimizedCallWidget/> as a minimized
 * WeldMeet meeting (app/weldmeet/components/meeting-pip-widget.tsx), fed by
 * the WeldChat call context.
 */
function PiPCallWidgetInner() {
  const { t } = useI18n();
  const {
    status,
    channelId,
    duration,
    isMuted,
    isVideoOff,
    isScreenSharing,
    handRaised,
    isFullscreen,
    isPiP,
    meeting,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    leaveCall,
    expandFromPiP,
  } = useWeldChatCall();
  const navigate = useNavigate();
  const { user } = useUser();
  const pathname = usePathname();
  const { data: channelData } = useChannel(channelId ?? '');
  const { data: membersData } = useChannelMembers(channelId ?? '');

  const channel = channelData?.data;
  const isDm = channel?.type === 'dm';
  const members = membersData?.data || [];
  const otherMember = isDm ? members.find((m) => m.userId !== user?.id) : null;

  const callLabel = isDm
    ? otherMember?.name || otherMember?.email || t.weldchat.pipCallWidget.call
    : channel?.name || t.weldchat.pipCallWidget.call;

  // Show when: connected, not fullscreen, and either explicitly minimized OR
  // navigated away from the call's conversation. Otherwise the inline room
  // view is on screen (and plays the call's audio itself).
  const isOnCallPage = isOnCallConversation(pathname, channelId, otherMember?.userId);
  const shouldShow = status === 'connected' && !isFullscreen && (isPiP || !isOnCallPage);

  const labels = useMemo<MinimizedCallWidgetLabels>(() => {
    const meet = getTranslations('weldmeet').pipWidget;
    return {
      ...meet,
      open: t.weldchat.pipCallWidget.openCall,
      leave: t.weldchat.pipCallWidget.leaveCall,
    };
  }, [t]);

  // Back to the call's conversation, where the call shows inline (not
  // fullscreen) — like a minimized meeting returns to its room page.
  const otherMemberUserId = otherMember?.userId;
  const channelType = channel?.type;
  const handleExpand = useCallback(() => {
    expandFromPiP();
    if (!channelId || isOnCallPage) return;
    if (channelType === 'dm') {
      // A DM with yourself has no other member: it lives at your own user id.
      const userId = otherMemberUserId || user?.id;
      if (userId) void navigate({ to: '/weldchat/dm/$userId', params: { userId } });
    } else if (channelType === 'group') {
      void navigate({ to: '/weldchat/dm/group/$channelId', params: { channelId } });
    } else {
      void navigate({ to: '/weldchat/$channelId', params: { channelId } });
    }
  }, [expandFromPiP, channelId, isOnCallPage, channelType, otherMemberUserId, user?.id, navigate]);

  // Same as the room's hangup: leaves the call, which carries on for the others.
  const handleLeave = useCallback(() => {
    void leaveCall();
  }, [leaveCall]);

  return (
    <MinimizedCallWidget
      status={status}
      meeting={meeting}
      title={callLabel}
      appName="WeldChat"
      duration={duration}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      isScreenSharing={isScreenSharing}
      handRaised={handRaised}
      shouldShow={shouldShow}
      playsRemoteAudio={shouldShow}
      labels={labels}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
      toggleHandRaise={toggleHandRaise}
      onLeave={handleLeave}
      onExpand={handleExpand}
      onPopOutClosed={expandFromPiP}
    />
  );
}
