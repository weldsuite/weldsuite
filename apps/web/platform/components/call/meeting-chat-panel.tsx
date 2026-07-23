/**
 * Meeting Chat Panel — platform data wrapper
 *
 * Wires @weldsuite/realtime, TanStack Query cache, Clerk identity, and platform-
 * specific mutations into the shared <SharedMeetingChatPanel> from
 * @weldsuite/weldmeet-ui. No visual code lives here.
 */

import { useMemo, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SharedMeetingChatPanel,
  MeetingChatNotification,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatParticipant,
} from '@weldsuite/weldmeet-ui';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  useMeetingMessages,
  useSendMeetingMessage,
  usePinMeetingMessage,
  useUnpinMeetingMessage,
  usePinnedMeetingMessages,
  meetingChatKeys,
  mergeMeetingMessageIntoCache,
  removeMeetingMessageFromCache,
} from '@/hooks/queries/use-meeting-chat-queries';
import { useMeetingChatRoom } from '@/hooks/weldmeet/use-meeting-chat-room';
import { useWeldChatMessagesRealtime } from '@/hooks/weldchat/use-weldchat-messages-realtime';

// ============================================================================
// Props
// ============================================================================

export interface MeetingChatPanelProps {
  meetingId: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  notificationHost?: HTMLElement | null;
  onClickAuthor?: (author: { id: string; name: string; avatar?: string | null }) => void;
  skipTransition?: boolean;
  /** Meeting participants offered in the composer's @-mention picker. */
  participants?: ChatParticipant[];
}

// ============================================================================
// Slide-out panel wrapper (matches original public API exactly)
// ============================================================================

export function MeetingChatPanel({ meetingId, isOpen, onClose, onOpen, notificationHost, onClickAuthor, participants }: MeetingChatPanelProps) {
  return (
    <MeetingChatDataProvider
      meetingId={meetingId}
      isOpen={isOpen}
      onClose={onClose}
      onOpen={onOpen}
      notificationHost={notificationHost}
      onClickAuthor={onClickAuthor}
      participants={participants}
    />
  );
}

/** Inline variant — embeds chat inside another panel, no outer border/width shell */
function MeetingChatContent({ meetingId }: { meetingId: string }) {
  return (
    <MeetingChatDataProvider
      meetingId={meetingId}
      isOpen={true}
      onClose={() => {}}
      inlineMode
    />
  );
}

// ============================================================================
// Data provider — wires all platform-specific hooks, renders shared UI
// ============================================================================

function MeetingChatDataProvider({
  meetingId,
  isOpen,
  onClose,
  onOpen,
  notificationHost,
  onClickAuthor,
  inlineMode = false,
  participants,
}: {
  meetingId: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  notificationHost?: HTMLElement | null;
  onClickAuthor?: (author: { id: string; name: string; avatar?: string | null }) => void;
  inlineMode?: boolean;
  participants?: ChatParticipant[];
}) {
  const t = useTranslations();
  const { userId } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  // app-api hosts the meeting chat + storage routes now (WeldMeet migration);
  // the upload presign/confirm flow lives at app-api /storage/*.
  const { getClient } = useAppApiClient();

  // ── Realtime ──────────────────────────────────────────────────────────────
  const { client } = useMeetingChatRoom(meetingId);
  const roomId = `meet_${meetingId}`;

  // ── Queries ───────────────────────────────────────────────────────────────
  // Declared before the realtime subscription so the gap-recovery callbacks
  // below can reference `isLoading` / `refetch`.
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMeetingMessages(meetingId);

  const onMessageCreated = useCallback(
    (message: any) => {
      mergeMeetingMessageIntoCache(queryClient, meetingId, message);
    },
    [meetingId, queryClient],
  );

  const onMessageDeleted = useCallback(
    (messageId: string) => {
      removeMeetingMessageFromCache(queryClient, meetingId, messageId);
    },
    [meetingId, queryClient],
  );

  useWeldChatMessagesRealtime(client, roomId, {
    onMessageCreated,
    onMessageDeleted,
    // Buffer realtime messages that arrive before the initial REST fetch
    // resolves, then flush — otherwise a just-merged live message can be
    // clobbered when the initial page load overwrites the cache.
    initialFetchDone: !isLoading,
    // When the host's WebSocket drops and reconnects, any messages sent during
    // the gap were never delivered to the live merge — previously they only
    // reappeared after a manual refetch (e.g. switching meeting view). Refetch
    // on reconnect to catch up. This is the fix for "guest messages don't show
    // until I switch a view".
    onGapDetected: () => {
      void refetch();
    },
  });

  const { data: pinnedData } = usePinnedMeetingMessages(meetingId);
  const { mutate: pinMessage } = usePinMeetingMessage();
  const { mutate: unpinMessage } = useUnpinMeetingMessage();
  const { mutate: sendMessageMutate } = useSendMeetingMessage();

  // ── Derived data ──────────────────────────────────────────────────────────
  // API returns newest-first; reverse to chronological for the shared component.
  const messages = useMemo((): ChatMessage[] => {
    const raw: any[] =
      data?.pages?.flatMap((page: any) => page.data?.messages || []) || [];
    return [...raw].reverse();
  }, [data]);

  const pinnedMessages = useMemo(() => {
    const pins: any[] = pinnedData?.data?.messages ?? [];
    return pins.map((p: any) => ({ id: p.id, content: p.content }));
  }, [pinnedData]);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string, attachments?: ChatMessageAttachment[], html?: string) => {
      const ready = (attachments ?? []).filter((a) => !a._uploading && a.url);
      if (!text.trim() && ready.length === 0) return;
      sendMessageMutate({
        meetingId,
        content: text,
        htmlContent: html,
        attachments:
          ready.length > 0
            ? ready.map((a) => ({
                id: a.id ?? `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                fileName: a.fileName,
                fileSize: a.fileSize ?? 0,
                mimeType: a.mimeType ?? 'application/octet-stream',
                url: a.url,
              }))
            : undefined,
        _optimisticId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    },
    [meetingId, sendMessageMutate],
  );

  // Upload a file to R2 via the presign → PUT → confirm flow (same as WeldChat),
  // returning a persisted attachment with a real, shareable URL.
  const onUploadFile = useCallback(
    async (file: File): Promise<ChatMessageAttachment | null> => {
      try {
        const client = await getClient();
        const urlRes = await client.post<any>('/storage/generate-upload-url', {
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type,
        });
        const { uploadUrl, uploadToken, fileKey } = urlRes;
        await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });
        const confirmRes = await client.post<any>('/storage/confirm-upload', {
          uploadToken,
          fileKey,
        });
        const fileData = confirmRes?.file ?? confirmRes;
        if (!fileData?.url) return null;
        return {
          id: fileData?.id ?? fileKey,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          url: fileData.url,
        };
      } catch (err) {
        console.error('[MeetingChat] File upload failed:', err);
        return null;
      }
    },
    [getClient],
  );

  const handlePin = useCallback(
    (messageId: string) => {
      pinMessage({ meetingId, messageId });
    },
    [meetingId, pinMessage],
  );

  const handleUnpin = useCallback(
    (messageId: string) => {
      unpinMessage({ meetingId, messageId });
    },
    [meetingId, unpinMessage],
  );

  const canDeleteMessage = useCallback(
    (message: ChatMessage) => message.authorId === userId,
    [userId],
  );

  const currentUserId = userId ?? '';
  const currentUserName =
    user?.fullName || user?.firstName || user?.username || t('sweep.shared.you');

  // ── Inline mode wraps in the same inner-div structure MeetingChatContent
  //    used to render, keeping the surrounding layout expectations intact.
  if (inlineMode) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <SharedMeetingChatPanel
          isOpen={true}
          onClose={() => {}}
          messages={messages}
          isLoading={isLoading}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onFetchNextPage={fetchNextPage}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          participants={participants}
          onSendMessage={handleSend}
          onUploadFile={onUploadFile}
          pinnedMessages={pinnedMessages}
          onPinMessage={handlePin}
          onUnpinMessage={handleUnpin}
          canDeleteMessage={canDeleteMessage}
          onCopyToast={(msg) => toast.success(msg)}
          // Inline mode: suppress the outer shell (border-l, width) — the
          // caller controls the container. We exploit the fact that
          // SharedMeetingChatPanel returns null when isOpen=false, but when
          // isOpen=true it renders its own shell. For inline embedding we
          // want just the body — so we use width=0 hack isn't needed; the
          // outer shell's flex layout simply absorbs the fixed width.
          // The cleanest approach is to keep the full panel and let the
          // parent flex row handle sizing, same as the original did.
        />
      </div>
    );
  }

  return (
    <>
      <SharedMeetingChatPanel
        isOpen={isOpen}
        onClose={onClose}
        messages={messages}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onFetchNextPage={fetchNextPage}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        participants={participants}
        onSendMessage={handleSend}
        onUploadFile={onUploadFile}
        pinnedMessages={pinnedMessages}
        onPinMessage={handlePin}
        onUnpinMessage={handleUnpin}
        canDeleteMessage={canDeleteMessage}
        onCopyToast={(msg) => toast.success(msg)}
        onClickAuthor={onClickAuthor}
      />
      <MeetingChatNotification
        messages={messages}
        currentUserId={currentUserId}
        isChatOpen={isOpen}
        onOpenChat={onOpen}
        host={notificationHost}
      />
    </>
  );
}
