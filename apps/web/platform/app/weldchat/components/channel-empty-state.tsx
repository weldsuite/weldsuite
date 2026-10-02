import { Hash, Lock, MessageCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel, ChatChannelMember } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useChatContext } from './chat-context';

/** Channel row as `ChannelPage` reads it, extended with the DM-specific
 * `otherMembers` field `/chat-dm` projects. */
interface ChannelEmptyStateChannel extends ChatChannel {
  otherMembers?: ChatChannelMember[];
}

interface ChannelEmptyStateProps {
  channel: ChannelEmptyStateChannel | null | undefined;
}

function formatCreationDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

interface Creator {
  userId: string;
  name: string;
  picture?: string;
}

/** Inline avatar + name chip for whoever created the channel/DM; opens their profile. */
function CreatorChip({ creator }: Readonly<{ creator: Creator }>) {
  const { openUserProfile } = useChatContext();
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => openUserProfile(creator.userId)}
      className="inline-flex items-center gap-1.5 h-auto p-2 -ml-2 align-middle cursor-pointer focus-visible:outline-none"
    >
      <Avatar className="h-4 w-4 rounded-[5.5px]">
        {creator.picture && (
          <AvatarImage src={creator.picture} alt={creator.name} className="rounded-[5.5px]" />
        )}
        <AvatarFallback className="rounded-[5.5px] text-[8px] font-medium">
          {creator.name[0]!.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="font-medium leading-4 text-foreground hover:underline">{creator.name}</span>
    </Button>
  );
}

export function ChannelEmptyState({ channel }: Readonly<ChannelEmptyStateProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: membersData } = useWorkspaceMembers();
  const isPrivate = channel?.type === 'private';
  const isDm = channel?.type === 'dm';
  const isGroupDm = channel?.type === 'group' || (channel?.otherMembers?.length ?? 0) > 1;
  const creator = ((): Creator | null => {
    if (!channel?.createdBy) return null;
    const members = membersData?.data ?? [];
    const m = members.find((mm) => mm.userId === channel.createdBy);
    if (!m) return null;
    const name = m.name || m.email || null;
    if (!name) return null;
    return { userId: m.userId as string, name, picture: m.picture as string | undefined };
  })();
  const dateStr = formatCreationDate(channel?.createdAt);
  const onDate = dateStr ? ` ${t.weldchat.channelEmptyState.channelCreatedOn} ${dateStr}` : '';

  // DM empty state — friendlier, no channel-style cards.
  if (isDm || channel?.type === 'group') {
    const other = channel?.otherMembers?.[0];
    const displayName = isGroupDm
      ? channel?.otherMembers
          ?.map((m) => m.name || m.email || st('sweep.weldchat.channelEmptyState.memberFallback'))
          .join(', ') ||
        channel?.name ||
        st('sweep.weldchat.channelEmptyState.groupFallback')
      : other?.name ||
        other?.email ||
        channel?.name ||
        st('sweep.weldchat.channelEmptyState.directMessageFallback');

    return (
      <div className="px-6 pt-10 pb-6 max-w-3xl">
        <div className="flex items-center gap-3 mb-3">
          {isGroupDm ? (
            <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
              <MessageCircle className="h-4 w-4 text-muted-foreground" />
            </div>
          ) : (
            <Avatar className="h-8 w-8 !rounded-lg">
              {other?.picture && <AvatarImage src={other.picture} className="!rounded-lg" />}
              <AvatarFallback className="!rounded-lg text-xs">
                {(displayName || '?')[0].toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <h1 className="text-[22px] font-bold truncate">{displayName}</h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {isGroupDm ? (
            <>{t.weldchat.channelEmptyState.groupConversationBeginning}</>
          ) : (
            <>
              {creator ? (
                <>
                  <CreatorChip creator={creator} /> {t.weldchat.channelEmptyState.dmStarted}
                </>
              ) : (
                t.weldchat.channelEmptyState.dmStartedNoAuthor
              )}
              {onDate}.
            </>
          )}
        </p>
      </div>
    );
  }

  // Channel empty state
  const Icon = isPrivate ? Lock : Hash;

  return (
    <div className="px-6 pt-10 pb-6">
      <div className="flex items-center gap-2.5 mb-2">
        <Icon className="h-6 w-6 text-foreground/80 flex-shrink-0" />
        <h1 className="text-[22px] font-bold truncate">{channel?.name}</h1>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {creator ? (
          <>
            <CreatorChip creator={creator} /> {t.weldchat.channelEmptyState.channelCreated}
          </>
        ) : (
          <>{t.weldchat.channelEmptyState.channelCreatedNoAuthor}</>
        )}
        {onDate}. {t.weldchat.channelEmptyState.veryBeginning}{' '}
        <strong className="font-medium text-foreground">
          {isPrivate ? '🔒' : '#'}
          {channel?.name}
        </strong>{' '}
        {t.weldchat.channelEmptyState.channel}
      </p>
      {channel?.topic && (
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{channel.topic}</p>
      )}
    </div>
  );
}
