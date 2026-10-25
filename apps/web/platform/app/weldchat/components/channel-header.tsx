import { Hash, Lock, Phone } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { useObjectPanel } from '@/components/object-panel';
import { ActiveCallBanner } from './active-call-banner';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel, ChatChannelMember } from '@/hooks/queries/use-weldchat-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ChatCall } from '@weldsuite/db/schema/chat-calls';
import { getRecordChatTypeInfo, openRecordPanel } from '../lib/record-chat-types';
import { RecordChatFollowButton } from './record-chat-follow-button';

function VideoCameraIcon({ className, strokeWidth = 1.5 }: Readonly<{ className?: string; strokeWidth?: number }>) {
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

/** Channel row extended with the DM-specific `otherMembers` field `/chat-dm` projects. */
interface ChannelHeaderChannel extends ChatChannel {
  otherMembers?: ChatChannelMember[];
}

interface ChannelHeaderProps {
  channel: ChannelHeaderChannel;
  /** DM only: opens the other person's member panel. */
  onOpenMemberPanel?: () => void;
}


/**
 * Name of a record chat (a company's, a task's, …): the record type's icon and
 * the record's name instead of `#channel`, the type underneath, and buttons to
 * open the record next to the chat and to follow / unfollow it.
 */
function RecordChatTitle({
  channel,
  className,
  onClick,
}: Readonly<{ channel: ChannelHeaderChannel; className: string; onClick: () => void }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const info = getRecordChatTypeInfo(channel.entityType);
  const Icon = info?.icon ?? Hash;
  return (
    <button type="button" className={className} onClick={onClick} title={t.weldchat.channelHeader.showMembers}>
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span data-testid="chat-channel-name" className="text-[15px] font-semibold truncate">
          {channel.entityDisplayName || channel.name}
        </span>
        {info && <span className="text-xs text-muted-foreground truncate">{st(info.labelKey)}</span>}
      </span>
    </button>
  );
}

function RecordChatActions({ channel }: Readonly<{ channel: ChannelHeaderChannel }>) {
  const st = useTranslations();
  const { open: openObjectPanel } = useObjectPanel();
  const { isOpen: isEntitySheetOpen, close: closeEntitySheet } = useEntitySheet();
  const info = getRecordChatTypeInfo(channel.entityType);
  if (!info || !channel.entityId) return null;
  const entityId = channel.entityId;
  return (
    <>
      <RecordChatFollowButton entityType={info.type} entityId={entityId} channelId={channel.id} />
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        data-testid="chat-open-record"
        onClick={() => {
          if (isEntitySheetOpen) closeEntitySheet();
          openRecordPanel(openObjectPanel, info.type, entityId);
        }}
      >
        <info.icon className="h-4 w-4" />
        <span className="max-md:sr-only">{st(info.openLabelKey)}</span>
      </Button>
    </>
  );
}

export function ChannelHeader({ channel, onOpenMemberPanel }: Readonly<ChannelHeaderProps>) {
  const { t } = useI18n();
  const { startCall } = useWeldChatCall();
  const { isOpen: isEntitySheetOpen, close: closeEntitySheet } = useEntitySheet();
  const { getClient } = useAppApiClient();
  const { open: openObjectPanel } = useObjectPanel();
  const isDm = channel.type === 'dm';
  const isRecordChat = channel.type === 'entity';
  const dmOther = isDm ? channel.otherMembers?.[0] : null;

  // Clicking the name in the header opens the side panel: the person's member
  // panel in a DM, the global ChannelPanel (People / Bookmarks / Filters tabs)
  // everywhere else. There is no separate panel button.
  const openChannelPanel = () => {
    if (isEntitySheetOpen) closeEntitySheet();
    openObjectPanel({ type: 'channel', id: channel.id, initialTab: 'people' });
  };

  const { data: activeCallData } = useQuery({
    queryKey: weldchatKeys.activeCall(channel.id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ChatCall | null }>(`/chat-calls/active/${channel.id}`);
    },
    refetchInterval: 10000,
  });
  const hasActiveCall = !!activeCallData?.data;
  const callButtonsDisabled = hasActiveCall;

  const openPanel = isDm ? onOpenMemberPanel : openChannelPanel;
  const nameButtonClass =
    'flex items-center gap-2 min-w-0 -mx-1.5 -my-1 px-1.5 py-1 rounded-md hover:bg-accent dark:hover:bg-accent/50 transition-colors cursor-pointer text-left';

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0 max-md:gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDm && (
            <button
              type="button"
              className={nameButtonClass}
              onClick={openPanel}
              disabled={!openPanel}
              title={t.weldchat.channelHeader.showMemberDetails}
            >
              <Avatar className="h-[26px] w-[26px] flex-shrink-0 !rounded-lg">
                {dmOther?.picture && <AvatarImage src={dmOther.picture} className="!rounded-lg" />}
                <AvatarFallback className="text-[11px] !rounded-lg">
                  {(dmOther?.name || dmOther?.email || '?')[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span data-testid="chat-channel-name" className="font-semibold truncate">
                {dmOther?.name || dmOther?.email || channel.name}
              </span>
            </button>
          )}
          {isRecordChat && (
            <RecordChatTitle channel={channel} className={nameButtonClass} onClick={openChannelPanel} />
          )}
          {!isDm && !isRecordChat && (
            <button
              type="button"
              className={nameButtonClass}
              onClick={openPanel}
              title={t.weldchat.channelHeader.showMembers}
            >
              {channel.type === 'private' ? (
                <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              )}
              <span data-testid="chat-channel-name" className="text-[15px] font-semibold truncate">{channel.name}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {isRecordChat && <RecordChatActions channel={channel} />}
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

