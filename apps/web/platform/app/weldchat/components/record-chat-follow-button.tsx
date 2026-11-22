import { Bell, BellPlus, Check, Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import {
  useChannel,
  useFollowRecordChat,
  useUnfollowRecordChat,
  type ChatChannelMember,
} from '@/hooks/queries/use-weldchat-queries';
import type { RecordChatType } from '../lib/record-chat-types';

interface RecordChatFollowButtonProps {
  entityType: RecordChatType;
  entityId: string;
  channelId: string;
  className?: string;
  /** A bell icon button with the label as its tooltip, for beside the call buttons. */
  iconOnly?: boolean;
}

/**
 * Follow / unfollow a record chat. Following puts the chat in the user's
 * WeldChat sidebar with unread state and notifications; unfollowing takes it
 * out again but leaves it readable on the record.
 *
 * Whether the user follows comes from the chat's member list (following is
 * membership), which the open chat has loaded already.
 */
export function RecordChatFollowButton({ entityType, entityId, channelId, className, iconOnly }: Readonly<RecordChatFollowButtonProps>) {
  const st = useTranslations();
  const { userId } = useAuth();
  const { data } = useChannel(channelId);
  const follow = useFollowRecordChat();
  const unfollow = useUnfollowRecordChat();

  const members = data?.data?.members as ChatChannelMember[] | undefined;
  if (!members || !userId) return null;

  const isFollowing = members.some((m) => m.userId === userId);
  const variables = { entityType, entityId, channelId };
  const toggle = () => {
    if (isFollowing) {
      unfollow.mutate(variables, { onError: () => toast.error(st('sweep.weldchat.recordChats.unfollowFailed')) });
    } else {
      follow.mutate(variables, { onError: () => toast.error(st('sweep.weldchat.recordChats.followFailed')) });
    }
  };
  const Icon = isFollowing ? Check : Plus;
  const busy = follow.isPending || unfollow.isPending;
  const hint = isFollowing ? st('sweep.weldchat.recordChats.unfollow') : st('sweep.weldchat.recordChats.followHint');

  if (iconOnly) {
    // A toggle: the label stays "Follow" and aria-pressed says whether it is on.
    const BellIcon = isFollowing ? Bell : BellPlus;
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8', className)}
        data-testid="record-chat-follow"
        aria-label={st('sweep.weldchat.recordChats.follow')}
        aria-pressed={isFollowing}
        disabled={busy}
        title={hint}
        onClick={toggle}
      >
        <BellIcon className={cn('!h-[18px] !w-[18px]', isFollowing && 'fill-current')} />
      </Button>
    );
  }

  return (
    <Button
      variant={isFollowing ? 'ghost' : 'outline'}
      size="sm"
      className={cn('h-8 gap-1.5 px-2', isFollowing && 'text-muted-foreground hover:text-foreground', className)}
      data-testid="record-chat-follow"
      aria-pressed={isFollowing}
      disabled={busy}
      title={hint}
      onClick={toggle}
    >
      <Icon className="h-4 w-4" />
      <span className="max-md:sr-only">
        {isFollowing ? st('sweep.weldchat.recordChats.following') : st('sweep.weldchat.recordChats.follow')}
      </span>
    </Button>
  );
}
