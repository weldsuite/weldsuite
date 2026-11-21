import { Hash, Lock, MessageCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { MemberAvatar } from '@/components/member-avatar';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel, ChatChannelMember } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { cn } from '@/lib/utils';
import { useChatContext } from './chat-context';

/** Channel row as `ChannelPage` reads it, extended with the DM-specific
 * `otherMembers` field `/chat-dm` projects. */
interface ChannelEmptyStateChannel extends ChatChannel {
  otherMembers?: ChatChannelMember[];
}

interface ChannelEmptyStateProps {
  channel: ChannelEmptyStateChannel | null | undefined;
}

/** "November 21, 2026" / "21 november 2026", in the app's language. */
function formatCreationDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

/**
 * The start of an empty conversation, lined up with the messages that will
 * follow it (their avatar column at 10px / 18px): the avatar or channel icon
 * and the name on one row, and under it one line on who started it and when.
 */
const INTRO_CLASS = 'px-[10px] pt-8 pb-4 md:px-[18px]';
const INTRO_ROW_CLASS = 'flex items-center gap-2';
const INTRO_TILE_CLASS = 'flex size-6 shrink-0 items-center justify-center rounded-[8px] bg-muted';
const INTRO_TITLE_CLASS = 'min-w-0 truncate text-xl font-semibold';
const INTRO_TEXT_CLASS = 'mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground';

interface Creator {
  userId: string;
  name: string;
  picture?: string;
}

/** Whoever created the channel or DM, named in the sentence; opens their profile. */
function CreatorName({ creator }: Readonly<{ creator: Creator }>) {
  const { openUserProfile } = useChatContext();
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => openUserProfile(creator.userId)}
      className="inline h-auto p-0 align-baseline text-sm font-medium text-foreground hover:bg-transparent hover:underline focus-visible:underline"
    >
      {creator.name}
    </Button>
  );
}

export function ChannelEmptyState({ channel }: Readonly<ChannelEmptyStateProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { intlLocale } = useDateLocale();
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
  const dateStr = formatCreationDate(channel?.createdAt, intlLocale);
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
      <div className={INTRO_CLASS}>
        <div className={INTRO_ROW_CLASS}>
          {isGroupDm ? (
            <div className={INTRO_TILE_CLASS}>
              <MessageCircle className="size-3.5 text-muted-foreground" />
            </div>
          ) : (
            // Their current picture (yours in a DM with yourself), as everywhere else.
            <MemberAvatar
              userId={other?.userId ?? channel?.createdBy}
              name={displayName}
              picture={other?.picture}
              className="size-6"
              fallbackClassName="text-[11px] font-medium"
              fallback={(displayName || '?')[0].toUpperCase()}
            />
          )}
          <h1 className={INTRO_TITLE_CLASS}>{displayName}</h1>
        </div>
        <p className={INTRO_TEXT_CLASS}>
          {isGroupDm ? (
            <>{t.weldchat.channelEmptyState.groupConversationBeginning}</>
          ) : (
            <>
              {creator ? (
                <>
                  <CreatorName creator={creator} /> {t.weldchat.channelEmptyState.dmStarted}
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
    <div className={INTRO_CLASS}>
      <div className={INTRO_ROW_CLASS}>
        <div className={INTRO_TILE_CLASS}>
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <h1 className={INTRO_TITLE_CLASS}>{channel?.name}</h1>
      </div>
      <p className={INTRO_TEXT_CLASS}>
        {creator ? (
          <>
            <CreatorName creator={creator} /> {t.weldchat.channelEmptyState.channelCreated}
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
      {channel?.topic && <p className={cn(INTRO_TEXT_CLASS, 'mt-1')}>{channel.topic}</p>}
    </div>
  );
}
