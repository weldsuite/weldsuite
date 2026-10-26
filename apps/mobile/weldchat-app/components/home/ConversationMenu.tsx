/**
 * Hold a channel or a conversation in a list for its menu: the native iOS
 * context menu (expo-router's Link.Menu), like Discord's and Slack's. Tapping
 * the row still opens it; the Link does the navigation.
 */
import { cloneElement, useState } from 'react';
import { Clipboard } from 'react-native';
import { Link, useRouter, type Href } from 'expo-router';
import { useAuth } from '@clerk/expo';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import type { RecordChatListItem } from '@weldsuite/app-api-client/domains/chat-entity-channels';

import type { DmChannel } from '@/lib/chat/dm';
import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';
import {
  cachedMembership,
  conversationWebUrl,
  forgetMembership,
  loadMembership,
  updateMembership,
  type NotificationLevel,
} from '@/lib/chat/conversation-menu';
import { recordAppFor } from '@/lib/record-chats/app-links';
import { hasUnreadMentions, isUnreadRecordChat, recordChatName } from '@/lib/record-chats/rules';
import { useOpenRecordInApp } from '@/hooks/useOpenRecordInApp';

export type MenuConversation =
  | { kind: 'channel'; id: string; name: string; type?: string; isMuted?: boolean; hasUnread?: boolean }
  | {
      kind: 'dm';
      id: string;
      name: string;
      isMuted?: boolean;
      isPinned?: boolean;
      hasUnread?: boolean;
      /** The other person in a 1:1 conversation; none for a group. */
      peerUserId?: string | null;
    }
  | {
      /** A chat on a company, person, task, project or domain. */
      kind: 'record';
      id: string;
      name: string;
      entityType: string;
      entityId: string;
      /** Following = a membership row: mute and notifications need one. */
      isFollowing: boolean;
      isMuted?: boolean;
      hasUnread?: boolean;
    };

/** A conversation from the DM list, as the menu takes it. */
export function dmMenuTarget(dm: DmChannel): MenuConversation {
  return {
    kind: 'dm',
    id: dm.id,
    name: dm.name,
    isMuted: dm.isMuted,
    isPinned: dm.isPinned,
    hasUnread: dm.hasUnread,
    peerUserId: dm.isGroup ? null : (dm.otherMembers?.[0]?.userId ?? null),
  };
}

/** A record chat from `/chat-entity-channels`, as the menu takes it. */
export function recordMenuTarget(chat: RecordChatListItem): MenuConversation {
  return {
    kind: 'record',
    id: chat.id,
    name: recordChatName(chat),
    entityType: chat.entityType,
    entityId: chat.entityId,
    isFollowing: chat.isFollowing,
    isMuted: chat.isMuted,
    hasUnread: chat.isFollowing && (isUnreadRecordChat(chat) || hasUnreadMentions(chat)),
  };
}

/** What changed, for the list to show it right away. */
export interface ConversationPatch {
  isMuted?: boolean;
  isPinned?: boolean;
  hasUnread?: boolean;
  archived?: boolean;
  /** A record chat followed or unfollowed. */
  isFollowing?: boolean;
}

interface ConversationMenuProps {
  conversation: MenuConversation;
  onChange: (id: string, patch: ConversationPatch) => void;
  /** The row. It gets the Link's onPress and an onPressIn, and must pass both on. */
  children: React.ReactElement<{ onPressIn?: () => void }>;
}

export function ConversationMenu({ conversation, onChange, children }: Readonly<ConversationMenuProps>) {
  const { t, format } = useI18n();
  const m = t.conversationMenu;
  const toast = useToast();
  const router = useRouter();
  const { userId } = useAuth();
  const openRecordInApp = useOpenRecordInApp();
  const { id } = conversation;
  const [level, setLevel] = useState<NotificationLevel | null>(
    () => cachedMembership(id, userId)?.notificationPreference ?? null,
  );
  // Without a membership (a record chat you don't follow) there is no level to load.
  const hasMembership = conversation.kind !== 'record' || conversation.isFollowing;

  // A long-press starts with a press-in: load the notification level then, so
  // the menu can tick it.
  const prefetch = () => {
    if (!userId || level || !hasMembership) return;
    loadMembership(id, userId)
      .then((membership) => {
        if (membership) setLevel(membership.notificationPreference);
      })
      .catch(() => {});
  };

  // Shown at once; put back, with a toast, if the request fails.
  const apply = (patch: ConversationPatch, revert: ConversationPatch, request: () => Promise<unknown>) => {
    onChange(id, patch);
    request().catch(() => {
      onChange(id, revert);
      toast.error(m.failed);
    });
  };

  const markRead = () =>
    apply({ hasUnread: false }, { hasUnread: true }, () => appApi.channels.markRead(id));

  const toggleMute = () => {
    if (!userId) return;
    const next = !conversation.isMuted;
    apply({ isMuted: next }, { isMuted: !next }, () => updateMembership(id, userId, { isMuted: next }));
  };

  const setNotificationLevel = (next: NotificationLevel) => {
    if (!userId || next === level) return;
    const previous = level;
    setLevel(next);
    updateMembership(id, userId, { notificationPreference: next }).catch(() => {
      setLevel(previous);
      toast.error(m.failed);
    });
  };

  const copyLink = () => {
    Clipboard.setString(
      conversationWebUrl(
        conversation.kind === 'dm'
          ? { kind: 'dm', id, peerUserId: conversation.peerUserId }
          : { kind: 'channel', id },
      ),
    );
    toast.success(m.linkCopied);
  };

  const toggleFollow = () => {
    if (conversation.kind !== 'record') return;
    const next = !conversation.isFollowing;
    const { entityType, entityId } = conversation;
    forgetMembership(id, userId);
    setLevel(null);
    apply({ isFollowing: next }, { isFollowing: !next }, () =>
      next
        ? appApi.chatEntityChannels.follow(entityType, entityId)
        : appApi.chatEntityChannels.unfollow(entityType, entityId),
    );
  };

  let href: Href;
  if (conversation.kind === 'channel') {
    href = { pathname: '/channel/[channelId]', params: { channelId: id, name: conversation.name, type: conversation.type ?? '' } } as Href;
  } else if (conversation.kind === 'record') {
    href = {
      pathname: '/channel/[channelId]',
      params: { channelId: id, name: conversation.name, type: 'entity', entityType: conversation.entityType },
    } as Href;
  } else {
    href = { pathname: '/dm/[channelId]', params: { channelId: id, name: conversation.name, type: 'dm' } } as Href;
  }

  const notifications = (
    <Link.Menu title={m.notifications} icon="bell.badge">
      <Link.MenuAction isOn={level === 'all'} onPress={() => setNotificationLevel('all')}>
        {m.notifyAll}
      </Link.MenuAction>
      <Link.MenuAction isOn={level === 'mentions'} onPress={() => setNotificationLevel('mentions')}>
        {m.notifyMentions}
      </Link.MenuAction>
      <Link.MenuAction isOn={level === 'none'} onPress={() => setNotificationLevel('none')}>
        {m.notifyNone}
      </Link.MenuAction>
    </Link.Menu>
  );

  const muteAction = (
    <Link.MenuAction icon={conversation.isMuted ? 'bell' : 'bell.slash'} onPress={toggleMute}>
      {conversation.isMuted ? m.unmute : m.mute}
    </Link.MenuAction>
  );

  if (conversation.kind === 'record') {
    const app = recordAppFor(conversation.entityType);
    const { entityType, entityId, isFollowing } = conversation;
    return (
      <Link href={href} push asChild>
        <Link.Trigger>{cloneElement(children, { onPressIn: prefetch })}</Link.Trigger>
        <Link.Menu title={conversation.name}>
          <Link.Menu inline>
            <Link.MenuAction icon="envelope.open" disabled={!conversation.hasUnread} onPress={markRead}>
              {m.markRead}
            </Link.MenuAction>
            {app ? (
              <Link.MenuAction icon="arrow.up.forward.app" onPress={() => void openRecordInApp(entityType, entityId)}>
                {format(t.recordChats.openIn, { app })}
              </Link.MenuAction>
            ) : null}
            <Link.MenuAction icon="link" onPress={copyLink}>
              {m.copyLink}
            </Link.MenuAction>
          </Link.Menu>
          {isFollowing ? (
            <Link.Menu inline>
              {muteAction}
              {notifications}
            </Link.Menu>
          ) : null}
          <Link.Menu inline>
            <Link.MenuAction icon={isFollowing ? 'minus.circle' : 'plus.circle'} onPress={toggleFollow}>
              {isFollowing ? t.recordChats.unfollow : t.recordChats.follow}
            </Link.MenuAction>
          </Link.Menu>
        </Link.Menu>
      </Link>
    );
  }

  return (
    <Link href={href} push asChild>
      <Link.Trigger>{cloneElement(children, { onPressIn: prefetch })}</Link.Trigger>
      {conversation.kind === 'channel' ? (
        <Link.Menu title={`#${conversation.name}`}>
          <Link.Menu inline>
            <Link.MenuAction icon="envelope.open" disabled={!conversation.hasUnread} onPress={markRead}>
              {m.markRead}
            </Link.MenuAction>
          </Link.Menu>
          <Link.Menu inline>
            <Link.MenuAction
              icon="person.badge.plus"
              onPress={() =>
                router.push({
                  pathname: '/invite-people/[channelId]',
                  params: { channelId: id, name: conversation.name },
                } as Href)
              }
            >
              {m.invite}
            </Link.MenuAction>
            <Link.MenuAction icon="link" onPress={copyLink}>
              {m.copyLink}
            </Link.MenuAction>
          </Link.Menu>
          <Link.Menu inline>
            {muteAction}
            {notifications}
          </Link.Menu>
          <Link.Menu inline>
            <Link.MenuAction icon="info.circle" onPress={() => router.push(`/channel-info/${id}` as Href)}>
              {m.channelDetails}
            </Link.MenuAction>
          </Link.Menu>
        </Link.Menu>
      ) : (
        <Link.Menu title={conversation.name}>
          <Link.Menu inline>
            <Link.MenuAction icon="envelope.open" disabled={!conversation.hasUnread} onPress={markRead}>
              {m.markRead}
            </Link.MenuAction>
            <Link.MenuAction
              icon={conversation.isPinned ? 'pin.slash' : 'pin'}
              onPress={() => {
                const next = !conversation.isPinned;
                apply({ isPinned: next }, { isPinned: !next }, () => appApi.chatDm.pin(id, { isPinned: next }));
              }}
            >
              {conversation.isPinned ? m.unpin : m.pin}
            </Link.MenuAction>
          </Link.Menu>
          <Link.Menu inline>
            {muteAction}
            {notifications}
          </Link.Menu>
          <Link.Menu inline>
            {conversation.peerUserId ? (
              <Link.MenuAction
                icon="person.crop.circle"
                onPress={() => router.push(`/user/${conversation.peerUserId}` as Href)}
              >
                {m.viewProfile}
              </Link.MenuAction>
            ) : null}
            <Link.MenuAction icon="link" onPress={copyLink}>
              {m.copyLink}
            </Link.MenuAction>
          </Link.Menu>
          <Link.Menu inline>
            <Link.MenuAction
              icon="archivebox"
              onPress={() => apply({ archived: true }, { archived: false }, () => appApi.chatDm.archive(id))}
            >
              {m.archive}
            </Link.MenuAction>
          </Link.Menu>
        </Link.Menu>
      )}
    </Link>
  );
}
