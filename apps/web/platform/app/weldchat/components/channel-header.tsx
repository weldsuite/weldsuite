import { Hash, Lock, Phone, Users, PanelLeftClose } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { useObjectPanel, useObjectPanelStack } from '@/components/object-panel';
import { ActiveCallBanner } from './active-call-banner';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/provider';

function VideoCameraIcon({ className, strokeWidth = 1.5 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      stroke="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
      />
    </svg>
  );
}

interface ChannelHeaderProps {
  channel: any;
  showMemberPanel?: boolean;
  onToggleMemberPanel?: () => void;
}


export function ChannelHeader({ channel, showMemberPanel, onToggleMemberPanel }: ChannelHeaderProps) {
  const { t } = useI18n();
  const { startCall, status } = useWeldChatCall();
  const { isOpen: isEntitySheetOpen, close: closeEntitySheet } = useEntitySheet();
  const { getClient } = useAppApiClient();
  const { open: openObjectPanel } = useObjectPanel();
  const objectStack = useObjectPanelStack();
  const isDm = channel.type === 'dm';
  const dmOther = isDm ? channel.otherMembers?.[0] : null;

  // Regular & entity channels expose a single "open panel" button that
  // launches the global ChannelPanel (same component as CompanyPanel).
  // People / Bookmarks / Filters live as tabs inside that panel — they no
  // longer get individual icons in this header.
  const topPanel = objectStack[objectStack.length - 1];
  const channelPanelOpen =
    !!topPanel && topPanel.type === 'channel' && topPanel.id === channel.id;

  const openChannelPanel = () => {
    if (isEntitySheetOpen) closeEntitySheet();
    openObjectPanel({ type: 'channel', id: channel.id, initialTab: 'people' });
  };

  const { data: activeCallData } = useQuery({
    queryKey: weldchatKeys.activeCall(channel.id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/chat-calls/active/${channel.id}`);
    },
    refetchInterval: 10000,
  });
  const hasActiveCall = !!activeCallData?.data;
  const callButtonsDisabled = hasActiveCall;

  // The vertical separator only makes sense when there's a button on BOTH
  // sides of it. When the channel panel is open the PanelLeftClose icon
  // disappears, and for non-DM channels there's no DM-only Users button —
  // so without this guard the divider would float alone next to the call
  // buttons.
  const hasLeftSideButton =
    (isDm && !!onToggleMemberPanel) || (!isDm && !channelPanelOpen);
  const hasCallButton =
    channel.videoCallsEnabled !== false || channel.voiceCallsEnabled !== false;

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0 max-md:gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDm ? (
            <>
              <Avatar className="h-[26px] w-[26px] flex-shrink-0 !rounded-lg">
                {dmOther?.picture && <AvatarImage src={dmOther.picture} className="!rounded-lg" />}
                <AvatarFallback className="text-[11px] !rounded-lg">
                  {(dmOther?.name || dmOther?.email || '?')[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <h2 data-testid="chat-channel-name" className="font-semibold truncate">
                {dmOther?.name || dmOther?.email || channel.name}
              </h2>
            </>
          ) : (
            <>
              {channel.type === 'private' ? (
                <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              )}
              <h2 data-testid="chat-channel-name" className="text-[15px] font-semibold truncate">{channel.name}</h2>
              {channel.topic && (
                <span className="text-sm text-muted-foreground truncate hidden md:block">
                  — {channel.topic}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {isDm && onToggleMemberPanel && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-8 w-8', showMemberPanel && 'bg-accent')}
              onClick={onToggleMemberPanel}
              title={t.weldchat.channelHeader.showMemberDetails}
            >
              <Users className="h-4 w-4" />
            </Button>
          )}
          {!isDm && !channelPanelOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={openChannelPanel}
              title={t.weldchat.channelHeader.showMembers}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
          {hasLeftSideButton && hasCallButton && (
            <div className="h-[19px] w-px bg-gray-200/70 dark:bg-secondary/70 shrink-0 mx-0.5" />
          )}
          {channel.videoCallsEnabled !== false && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid="chat-call-video"
              onClick={() => startCall(channel.id, 'video')}
              disabled={callButtonsDisabled}
              title={hasActiveCall ? t.weldchat.channelHeader.callAlreadyActive : t.weldchat.channelHeader.videoCall}
            >
              <VideoCameraIcon className="!h-[21px] !w-[21px]" strokeWidth={1.8} />
            </Button>
          )}
          {channel.voiceCallsEnabled !== false && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid="chat-call-voice"
              onClick={() => startCall(channel.id, 'voice')}
              disabled={callButtonsDisabled}
              title={hasActiveCall ? t.weldchat.channelHeader.callAlreadyActive : t.weldchat.channelHeader.voiceCall}
            >
              <Phone className="!h-[18px] !w-[18px]" />
            </Button>
          )}
        </div>
      </div>
      <ActiveCallBanner channelId={channel.id} />
    </>
  );
}

