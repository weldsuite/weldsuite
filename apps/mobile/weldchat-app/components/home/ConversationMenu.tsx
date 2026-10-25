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

import type { DmChannel } from '@/lib/chat/dm';
import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';
import {
  cachedMembership,
  conversationWebUrl,
  loadMembership,
  updateMembership,
  type NotificationLevel,
} from '@/lib/chat/conversation-menu';

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

/** What changed, for the list to show it right away. */
export interface ConversationPatch {
  isMuted?: boolean;
  isPinned?: boolean;
  hasUnread?: boolean;
  archived?: boolean;
}

interface ConversationMenuProps {
  conversation: MenuConversation;
  onChange: (id: string, patch: ConversationPatch) => void;
  /** The row. It gets the Link's onPress and an onPressIn, and must pass both on. */
  children: React.ReactElement<{ onPressIn?: () => void }>;
}

export function ConversationMenu({ conversation, onChange, children }: Readonly<ConversationMenuProps>) {
  const { t } = useI18n();
  const m = t.conversationMenu;
  const toast = useToast();
  const router = useRouter();
  const { userId } = useAuth();
  const { id, kind } = conversation;
  const [level, setLevel] = useState<NotificationLevel | null>(
    () => cachedMembership(id)?.notificationPreference ?? null,
  );

  // A long-press starts with a press-in: load the notification level then, so
  // the menu can tick it.
  const prefetch = () => {
    if (!userId || level) return;
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

  const href = (
    kind === 'channel'
      ? { pathname: '/channel/[channelId]', params: { channelId: id, name: conversation.name, type: conversation.type ?? '' } }
      : { pathname: '/dm/[channelId]', params: { channelId: id, name: conversation.name, type: 'dm' } }
  ) as Href;

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
