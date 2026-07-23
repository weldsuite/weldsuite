'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useSupportRoom } from '@weldsuite/realtime/react';
import {
  Headphones,
  Send,
  Building2,
  MessageCircle,
  Inbox,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SupportWorkspace } from '@/lib/support-data';
import { fetchSupportMessages } from '@/actions/support-messages';
import { replyToSupport } from '@/actions/support';

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

type Message = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  authorType: string;
  content: string;
  createdAt: Date | string;
};

export function SupportInbox({ workspaces }: { workspaces: SupportWorkspace[] }) {
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const selected = workspaces.find((ws) => ws.clerkOrgId === selectedOrgId);

  return (
    <div className="flex h-full">
      <div className="w-80 border-r flex flex-col bg-background">
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          <Headphones className="h-5 w-5 text-blue-600" />
          <h1 className="text-sm font-semibold">Support Inbox</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          <WorkspaceList
            workspaces={workspaces}
            selected={selectedOrgId}
            onSelect={setSelectedOrgId}
          />
        </div>
      </div>

      {selectedOrgId && selected ? (
        <ChatView key={selectedOrgId} orgId={selectedOrgId} workspaceName={selected.name} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <MessageCircle className="h-10 w-10 mx-auto" />
            <p className="text-sm">Select a workspace to view their support channel</p>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceList({
  workspaces,
  selected,
  onSelect,
}: {
  workspaces: SupportWorkspace[];
  selected: string | null;
  onSelect: (orgId: string) => void;
}) {
  if (workspaces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm px-4 text-center">
        <Inbox className="h-8 w-8 mb-2" />
        No enterprise workspaces found.
      </div>
    );
  }

  return (
    <div className="space-y-0.5 p-2">
      {workspaces.map((ws) => {
        const msgCount = ws.supportChannel?.messageCount ?? 0;
        const lastMsg = ws.supportChannel?.lastMessagePreview;
        const hasChannel = !!ws.supportChannel;
        const isSelected = selected === ws.clerkOrgId;

        return (
          <button
            key={ws.id}
            onClick={() => ws.clerkOrgId && onSelect(ws.clerkOrgId)}
            className={cn(
              'w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
              isSelected ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <div className="h-9 w-9 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 mt-0.5">
              {ws.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ws.imageUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
              ) : (
                <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                  {(ws.name || '?').substring(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{ws.name}</span>
                {msgCount > 0 && (
                  <span className="text-[10px] text-muted-foreground">{msgCount}</span>
                )}
              </div>
              {lastMsg ? (
                <p className="text-xs text-muted-foreground truncate mt-0.5">{lastMsg}</p>
              ) : (
                <p className="text-xs text-muted-foreground italic mt-0.5">
                  {hasChannel ? 'No messages yet' : 'No channel created'}
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ChatView({ orgId, workspaceName }: { orgId: string; workspaceName: string }) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [content, setContent] = useState('');
  const [isSending, startSendTransition] = useTransition();
  const [initialScrollDone, setInitialScrollDone] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stableGetToken = useCallback(async () => (await getToken()) || '', [getToken]);
  const adminName = user?.fullName || user?.firstName || 'Support';

  const { on, typingUsers, startTyping, stopTyping } = useSupportRoom(orgId, {
    baseUrl: REALTIME_URL,
    getToken: stableGetToken,
    userName: adminName,
  });

  const reload = useCallback(async () => {
    const result = await fetchSupportMessages(orgId);
    setMessages([...result.messages].reverse());
    setHasMore(result.hasMore);
    setNextCursor(result.nextCursor);
    setIsLoading(false);
  }, [orgId]);

  useEffect(() => {
    setIsLoading(true);
    setMessages([]);
    setNextCursor(null);
    setHasMore(false);
    setInitialScrollDone(false);
    setContent('');
    void reload();
  }, [orgId, reload]);

  useEffect(() => {
    const unsub = on('message', () => {
      void reload();
    });
    return unsub;
  }, [on, reload]);

  useEffect(() => {
    if (messages.length > 0 && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: initialScrollDone ? 'smooth' : 'instant' });
      if (!initialScrollDone) setInitialScrollDone(true);
    }
  }, [messages.length, initialScrollDone]);

  const loadMore = useCallback(async () => {
    if (isFetchingMore || !hasMore || !nextCursor) return;
    setIsFetchingMore(true);
    try {
      const result = await fetchSupportMessages(orgId, nextCursor);
      setMessages((prev) => [...[...result.messages].reverse(), ...prev]);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } finally {
      setIsFetchingMore(false);
    }
  }, [hasMore, isFetchingMore, nextCursor, orgId]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < 100 && hasMore && !isFetchingMore) {
      void loadMore();
    }
  };

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || isSending) return;
    stopTyping();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setContent('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    startSendTransition(async () => {
      const result = await replyToSupport({
        orgId,
        content: trimmed,
        authorName: adminName,
        authorAvatar: user?.imageUrl ?? null,
      });
      if (result.ok) {
        await reload();
      } else {
        // Restore content so the user can retry
        setContent(trimmed);
        console.error(result.error);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="border-b px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="h-9 w-9 rounded-full bg-blue-600 flex items-center justify-center">
          <Building2 className="h-5 w-5 text-white" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">{workspaceName}</h2>
          <p className="text-xs text-muted-foreground">Enterprise support channel</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No messages in this channel yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-4" onScroll={handleScroll}>
          {isFetchingMore && (
            <div className="flex justify-center py-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          )}
          {messages.map((msg) => {
            const isSupport = msg.authorType === 'support';
            const initials = (msg.authorName || '?')
              .split(' ')
              .map((n) => n[0])
              .join('')
              .substring(0, 2)
              .toUpperCase();

            return (
              <div
                key={msg.id}
                className={cn('flex gap-3 px-4 py-1.5', isSupport && 'flex-row-reverse')}
              >
                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
                  {msg.authorAvatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={msg.authorAvatar}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-xs font-medium">{initials}</span>
                  )}
                </div>
                <div className={cn('flex flex-col max-w-[70%]', isSupport && 'items-end')}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium">{msg.authorName}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {isSupport && (
                      <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-1.5 py-0.5 rounded-full">
                        Support
                      </span>
                    )}
                  </div>
                  <div
                    className={cn(
                      'rounded-xl px-3 py-2 text-sm leading-relaxed',
                      isSupport
                        ? 'bg-blue-600 text-white rounded-tr-sm'
                        : 'bg-muted text-foreground rounded-tl-sm',
                    )}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {typingUsers.length > 0 && (
        <div className="px-4 pb-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
            </span>
            <span>
              {typingUsers.map((u) => u.userName).join(', ')}{' '}
              {typingUsers.length === 1 ? 'is' : 'are'} typing...
            </span>
          </div>
        </div>
      )}

      <div className="border-t bg-background p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';

              startTyping();
              if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
              typingTimeoutRef.current = setTimeout(() => stopTyping(), 2000);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Reply as support..."
            rows={1}
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={handleSend}
            disabled={!content.trim() || isSending}
            className="shrink-0 h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
