/**
 * Messenger state: the visitor's conversations, loaded threads, optimistic
 * sends and live updates.
 *
 * Who the visitor is comes from the visitor session (lib/visitor-session):
 * every API call carries its token, and when the host page signs someone in
 * or out the session switches visitor and everything on screen is dropped.
 *
 * Live updates come from the ConversationRoom realtime socket (one per recent
 * open conversation, so the launcher badge updates even while the widget is
 * closed). If realtime is unavailable — no URL advertised, token rejected,
 * network blocks WebSockets — the messenger quietly falls back to polling so
 * replies still arrive.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RoomClient } from '@weldsuite/realtime/client';
import type { ConnectionState, RoomEvent } from '@weldsuite/realtime/types';
import type { MessageAttachment, PublicConversation, PublicMessage, ThreadMessage } from '@/lib/api/types';
import { getCustomerProfile, saveCustomerProfile } from '@/lib/utils/customer-storage';
import { loadSeen, saveSeen } from '@/lib/utils/seen-storage';
import { playMessageReceivedSound } from '@/lib/utils/notification-sound';
import { getVisitorSession } from '@/lib/visitor-session';

/** Thread key for a conversation that hasn't been created yet. */
export const DRAFT_ID = '__draft__';

const WATCHED_ROOMS = 3;
const LIST_POLL_MS = 20_000;
const THREAD_POLL_MS = 5_000;
const TYPING_REPEAT_MS = 3_000;
const TYPING_IDLE_MS = 4_000;

interface Options {
  widgetId: string;
  realtimeUrl: string | null;
  /** Widget panel is visible to the visitor. */
  isOpen: boolean;
  /** Conversation currently on screen (or DRAFT_ID), if any. */
  activeId: string | null;
  initialName?: string;
  initialEmail?: string;
}

function newClientId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  return `c_${Date.now().toString(36)}${suffix}`;
}

function time(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

function mergeMessage(messages: ThreadMessage[], incoming: PublicMessage): ThreadMessage[] {
  const index = messages.findIndex(
    (m) => m.id === incoming.id || (incoming.clientId !== null && m.clientId === incoming.clientId),
  );
  if (index >= 0) {
    const next = [...messages];
    next[index] = { ...incoming };
    return next;
  }
  return [...messages, incoming].sort((a, b) => time(a.createdAt) - time(b.createdAt));
}

function upsertConversation(list: PublicConversation[], conversation: PublicConversation) {
  const others = list.filter((c) => c.id !== conversation.id);
  return [conversation, ...others].sort(
    (a, b) => time(b.lastMessageAt ?? b.createdAt) - time(a.lastMessageAt ?? a.createdAt),
  );
}

function isVisitorSender(senderType: string | undefined): boolean {
  return senderType === 'visitor' || senderType === 'customer';
}

function isPublicMessageRecord(value: unknown): value is PublicMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { createdAt?: unknown }).createdAt === 'string'
  );
}

export function useMessenger({ widgetId, realtimeUrl, isOpen, activeId, initialName, initialEmail }: Options) {
  const session = useMemo(() => getVisitorSession(widgetId), [widgetId]);
  const api = session.api;
  const { status, visitor } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const visitorId = visitor?.id ?? null;
  const verified = Boolean(visitor?.verified);

  /** Answers for a visitor who has since been replaced (sign-in / sign-out) are dropped. */
  const isCurrent = useCallback(
    (before: string | null) => before === null || session.getSnapshot().visitor?.id === before,
    [session],
  );

  // A verified visitor's name and email are the ones the site vouched for; the
  // rest is what the visitor (or the page, unverified) typed.
  const profile = useMemo(() => {
    if (visitor?.verified) return { name: visitor.name ?? '', email: visitor.email ?? '' };
    const stored = visitor ? null : getCustomerProfile(widgetId);
    return {
      name: visitor?.name || initialName || stored?.name || '',
      email: visitor?.email || initialEmail || stored?.email || '',
    };
  }, [widgetId, visitor, initialName, initialEmail]);

  const [conversations, setConversations] = useState<PublicConversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [threads, setThreads] = useState<Record<string, ThreadMessage[]>>({});
  const [loadingThread, setLoadingThread] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, string | null>>({});
  const [connection, setConnection] = useState<Record<string, ConnectionState>>({});
  const [seen, setSeen] = useState<Record<string, string>>(() => loadSeen(widgetId) ?? {});
  const seenInitialized = useRef(loadSeen(widgetId) !== null);

  const rooms = useRef(new Map<string, RoomClient>());
  const stateRef = useRef({ isOpen, activeId });
  stateRef.current = { isOpen, activeId };

  // ---- identity ----------------------------------------------------------

  // Open the session (also the moment a widget that wants signed-in users says so).
  useEffect(() => {
    void session.getToken().catch(() => setConversationsLoaded(true));
  }, [session]);

  useEffect(() => {
    if (!visitorId) return;
    saveCustomerProfile(widgetId, {
      name: profile.name || undefined,
      email: profile.email || undefined,
    });
  }, [widgetId, visitorId, profile]);

  // Host page passed name/email (`?name=&email=`): tell the API once. Ignored for a verified visitor.
  useEffect(() => {
    if (!initialEmail && !initialName) return;
    void session.identifyTyped({ name: initialName, email: initialEmail }).catch(() => {});
  }, [session, initialEmail, initialName]);

  const identify = useCallback(
    (email: string, name?: string) => session.identifyTyped({ email, name }),
    [session],
  );

  // ---- conversations list ------------------------------------------------

  const refreshConversations = useCallback(async () => {
    const before = session.getSnapshot().visitor?.id ?? null;
    try {
      const list = await api.listConversations();
      if (!isCurrent(before)) return;
      setConversations(list);
      if (!seenInitialized.current) {
        // First run on this device (or for this visitor): don't flag history as unread.
        seenInitialized.current = true;
        setSeen((prev) => {
          const next = { ...prev };
          for (const c of list) if (c.lastMessageAt && !next[c.id]) next[c.id] = c.lastMessageAt;
          return next;
        });
      }
    } catch {
      // keep what we have; the next poll retries
    } finally {
      if (isCurrent(before)) setConversationsLoaded(true);
    }
  }, [api, session, isCurrent]);

  // A different visitor (signed in / out on the site): nothing of the previous one stays.
  const shownVisitor = useRef<string | null>(null);
  useEffect(() => {
    if (shownVisitor.current && shownVisitor.current !== visitorId) {
      for (const client of rooms.current.values()) client.disconnect();
      rooms.current.clear();
      setConversations([]);
      setThreads({});
      setTyping({});
      setConnection({});
      setConversationsLoaded(false);
      seenInitialized.current = false;
    }
    shownVisitor.current = visitorId;
    if (visitorId) void refreshConversations();
  }, [visitorId, refreshConversations]);

  useEffect(() => {
    saveSeen(widgetId, seen);
  }, [widgetId, seen]);

  // ---- threads -----------------------------------------------------------

  const loadThread = useCallback(
    async (conversationId: string, { silent = false } = {}) => {
      if (conversationId === DRAFT_ID) return;
      const before = session.getSnapshot().visitor?.id ?? null;
      if (!silent) setLoadingThread(conversationId);
      try {
        const result = await api.getConversation(conversationId);
        if (!isCurrent(before)) return;
        setThreads((prev) => {
          const pending = (prev[conversationId] ?? []).filter((m) => m.status);
          let merged: ThreadMessage[] = result.messages;
          for (const p of pending) {
            if (!merged.some((m) => m.clientId && m.clientId === p.clientId)) merged = [...merged, p];
          }
          return { ...prev, [conversationId]: merged };
        });
        setConversations((prev) => upsertConversation(prev, result.conversation));
      } catch {
        // surfaced as an empty thread; polling / reconnect will retry
      } finally {
        if (!silent) setLoadingThread((id) => (id === conversationId ? null : id));
      }
    },
    [api, session, isCurrent],
  );

  useEffect(() => {
    if (activeId && activeId !== DRAFT_ID && !threads[activeId]) void loadThread(activeId);
  }, [activeId, threads, loadThread]);

  const markSeen = useCallback((conversationId: string, at: string | null) => {
    if (!at) return;
    setSeen((prev) => (time(prev[conversationId]) >= time(at) ? prev : { ...prev, [conversationId]: at }));
  }, []);

  // Viewing a conversation with the panel open = everything in it is read.
  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  useEffect(() => {
    if (!isOpen || !activeConversation) return;
    markSeen(activeConversation.id, activeConversation.lastMessageAt);
  }, [isOpen, activeConversation, markSeen]);

  // ---- realtime ------------------------------------------------------------

  const handleIncoming = useCallback(
    (conversationId: string, event: Extract<RoomEvent, { type: 'message' }>) => {
      const record = isPublicMessageRecord(event.record) ? event.record : null;
      if (record) {
        setThreads((prev) =>
          prev[conversationId] ? { ...prev, [conversationId]: mergeMessage(prev[conversationId], record) } : prev,
        );
      } else {
        void loadThread(conversationId, { silent: true });
      }
      const fromTeam = !isVisitorSender(event.senderType);
      const createdAt = record?.createdAt ?? new Date(event.ts).toISOString();
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                state: 'open',
                lastMessageAt: createdAt,
                lastMessagePreview: (event.content || c.lastMessagePreview || '').slice(0, 200),
                lastMessageFromTeam: fromTeam,
              }
            : c,
        ),
      );
      if (fromTeam) {
        setTyping((prev) => ({ ...prev, [conversationId]: null }));
        const { isOpen: open, activeId: current } = stateRef.current;
        const watching = open && current === conversationId && !document.hidden;
        if (!watching) playMessageReceivedSound();
      }
    },
    [loadThread],
  );

  const handleSystem = useCallback(
    (conversationId: string, event: Extract<RoomEvent, { type: 'system' }>) => {
      const data = (event.data ?? {}) as { conversation?: PublicConversation; record?: unknown; state?: string };
      if (data.conversation?.id === conversationId) {
        setConversations((prev) => upsertConversation(prev, data.conversation!));
      } else if (data.state === 'open' || data.state === 'closed') {
        const state = data.state;
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, state } : c)));
      }
      if (isPublicMessageRecord(data.record)) {
        const record = data.record;
        setThreads((prev) =>
          prev[conversationId] ? { ...prev, [conversationId]: mergeMessage(prev[conversationId], record) } : prev,
        );
      }
    },
    [],
  );

  // Watch the active conversation plus the most recent open ones.
  const watchedIds = useMemo(() => {
    const ids = conversations
      .filter((c) => c.state === 'open')
      .slice(0, WATCHED_ROOMS)
      .map((c) => c.id);
    if (activeId && activeId !== DRAFT_ID && !ids.includes(activeId)) ids.push(activeId);
    ids.sort((a, b) => a.localeCompare(b));
    return ids.join(',');
  }, [conversations, activeId]);

  useEffect(() => {
    if (!realtimeUrl) return;
    const wanted = new Set(watchedIds ? watchedIds.split(',') : []);
    const current = rooms.current;

    for (const [id, client] of current) {
      if (!wanted.has(id)) {
        client.disconnect();
        current.delete(id);
      }
    }

    for (const id of wanted) {
      if (current.has(id)) continue;
      const client = new RoomClient({
        url: `${realtimeUrl.replace(/\/$/, '')}/ws/conversation/${id}`,
        getToken: async () => (await api.realtimeToken(id)).token,
      });
      current.set(id, client);
      client.on('message', (event) => handleIncoming(id, event));
      client.on('system', (event) => handleSystem(id, event));
      client.onTyping((users) => {
        const agent = users.find((u) => !u.userId.startsWith('visitor:'));
        setTyping((prev) => ({ ...prev, [id]: agent ? agent.userName : null }));
      });
      client.onConnectionChange((state) => {
        setConnection((prev) => ({ ...prev, [id]: state }));
        // Catch up on anything missed while the socket was down.
        if (state === 'connected') void loadThread(id, { silent: true });
      });
      void client.connect();
    }
  }, [watchedIds, realtimeUrl, api, handleIncoming, handleSystem, loadThread]);

  useEffect(
    () => () => {
      for (const client of rooms.current.values()) client.disconnect();
      rooms.current.clear();
    },
    [],
  );

  // Presence: agents see the visitor as online while the thread is on screen.
  useEffect(() => {
    if (!activeId || activeId === DRAFT_ID || !isOpen) return;
    const client = rooms.current.get(activeId);
    if (!client) return;
    const enter = () => client.enterPresence({ role: 'visitor' });
    if (client.isConnected) enter();
    const off = client.onConnectionChange((state) => state === 'connected' && enter());
    return () => {
      off();
      client.leavePresence();
    };
  }, [activeId, isOpen, watchedIds]);

  // ---- polling fallback ------------------------------------------------------

  const activeLive = activeId ? connection[activeId] === 'connected' : false;
  useEffect(() => {
    if (!isOpen || status === 'identity-required') return;
    const listTimer = setInterval(() => void refreshConversations(), LIST_POLL_MS);
    const threadTimer =
      activeId && activeId !== DRAFT_ID && !activeLive
        ? setInterval(() => void loadThread(activeId, { silent: true }), THREAD_POLL_MS)
        : null;
    return () => {
      clearInterval(listTimer);
      if (threadTimer) clearInterval(threadTimer);
    };
  }, [isOpen, status, activeId, activeLive, refreshConversations, loadThread]);

  // ---- typing ---------------------------------------------------------------

  const typingSentAt = useRef(0);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTyping = useCallback(() => {
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = null;
    if (!typingSentAt.current) return;
    typingSentAt.current = 0;
    const id = stateRef.current.activeId;
    if (id) rooms.current.get(id)?.stopTyping();
  }, []);

  const notifyTyping = useCallback(() => {
    const id = stateRef.current.activeId;
    const client = id ? rooms.current.get(id) : undefined;
    if (!client?.isConnected) return;
    const now = Date.now();
    if (now - typingSentAt.current > TYPING_REPEAT_MS) {
      typingSentAt.current = now;
      client.startTyping();
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [stopTyping]);

  // ---- sending ----------------------------------------------------------------

  const setMessageStatus = (threadId: string, clientId: string, status: ThreadMessage['status']) =>
    setThreads((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).map((m) => (m.clientId === clientId ? { ...m, status } : m)),
    }));

  /**
   * Send a message. For the draft thread this creates the conversation and
   * resolves with its id so the view can switch over to it. Attachments are
   * already uploaded (see `uploadAttachment`) and only valid in an existing
   * conversation: starting one is text-only.
   */
  const send = useCallback(
    async (
      threadId: string,
      body: string,
      options: { attachments?: MessageAttachment[]; clientId?: string } = {},
    ): Promise<string | null> => {
      const trimmed = body.trim();
      const attachments = threadId === DRAFT_ID ? [] : (options.attachments ?? []);
      if (!trimmed && attachments.length === 0) return null;
      const clientId = options.clientId ?? newClientId();
      stopTyping();

      const optimistic: ThreadMessage = {
        id: clientId,
        clientId,
        conversationId: threadId,
        kind: 'message',
        body: trimmed || null,
        authorType: 'visitor',
        authorName: null,
        authorAvatar: null,
        attachments: attachments.length > 0 ? attachments : null,
        eventType: null,
        createdAt: new Date().toISOString(),
        status: 'sending',
      };
      setThreads((prev) => ({
        ...prev,
        [threadId]: [...(prev[threadId] ?? []).filter((m) => m.clientId !== clientId), optimistic],
      }));

      try {
        if (threadId === DRAFT_ID) {
          const result = await api.startConversation({
            // A verified visitor's name and email are on the visitor already.
            name: verified ? undefined : profile.name || undefined,
            email: verified ? undefined : profile.email || undefined,
            body: trimmed,
            clientId,
          });
          const id = result.conversation.id;
          setThreads((prev) => {
            const { [DRAFT_ID]: _draft, ...rest } = prev;
            return { ...rest, [id]: [result.message] };
          });
          setConversations((prev) => upsertConversation(prev, result.conversation));
          markSeen(id, result.conversation.lastMessageAt);
          return id;
        }

        const result = await api.sendMessage(threadId, {
          body: trimmed || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          clientId,
        });
        setThreads((prev) => ({
          ...prev,
          [threadId]: mergeMessage(prev[threadId] ?? [], result.message),
        }));
        setConversations((prev) => upsertConversation(prev, result.conversation));
        markSeen(threadId, result.conversation.lastMessageAt);
        return threadId;
      } catch {
        setMessageStatus(threadId, clientId, 'failed');
        return null;
      }
    },
    [api, verified, profile, stopTyping, markSeen],
  );

  const retry = useCallback(
    (threadId: string, message: ThreadMessage) => {
      if ((!message.body && !message.attachments?.length) || !message.clientId) return Promise.resolve(null);
      return send(threadId, message.body ?? '', {
        attachments: message.attachments ?? undefined,
        clientId: message.clientId,
      });
    },
    [send],
  );

  /** Rate a closed conversation (1–5, optional comment). Throws when the API refuses. */
  const rate = useCallback(
    async (conversationId: string, rating: number, comment?: string) => {
      const result = await api.rateConversation(conversationId, {
        rating,
        comment: comment?.trim() || undefined,
      });
      setConversations((prev) => upsertConversation(prev, result.conversation));
      setThreads((prev) =>
        prev[conversationId]
          ? { ...prev, [conversationId]: mergeMessage(prev[conversationId], result.message) }
          : prev,
      );
    },
    [api],
  );

  /** Upload one file into an existing conversation, ready to go out with the next message. */
  const uploadAttachment = useCallback(
    (conversationId: string, file: File) => api.uploadAttachment({ conversationId, file }),
    [api],
  );

  // ---- derived -------------------------------------------------------------

  const isUnread = useCallback(
    (c: PublicConversation) => c.lastMessageFromTeam && time(c.lastMessageAt) > time(seen[c.id]),
    [seen],
  );
  const unreadCount = conversations.filter(isUnread).length;

  return {
    /** `identity-required`: this widget only chats with users the site signed in. */
    status,
    /** Changes when the host page signs someone in or out; null while a session opens. */
    visitorId,
    /** The site vouched for this visitor (identity token): name and email are fixed. */
    verified,
    profile,
    identify,
    conversations,
    conversationsLoaded,
    refreshConversations,
    threads,
    loadingThread,
    typing,
    isUnread,
    unreadCount,
    send,
    rate,
    uploadAttachment,
    retry,
    notifyTyping,
    stopTyping,
  };
}

export type Messenger = ReturnType<typeof useMessenger>;
