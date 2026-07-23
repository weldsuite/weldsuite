import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import api from '../services/api';
import { useClerkAuth } from './ClerkAuthContext';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import { topics } from '@weldsuite/realtime/topics';
import type { ConnectionState } from '@weldsuite/realtime/types';

// ============================================================================
// Mail event payload types
// ============================================================================

interface MailNewEmailEvent {
  id: string;
  accountId: string;
  labels: string[];
  messageId: string;
  subject: string;
  from: { email: string; name?: string };
  preview: string;
  receivedDate: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
}

interface MailReadEvent {
  id: string;
  accountId: string;
  isRead: boolean;
}

interface MailStarredEvent {
  id: string;
  accountId: string;
  isStarred: boolean;
}

interface MailDeletedEvent {
  id: string;
  accountId: string;
}

interface MailArchivedEvent {
  id: string;
  accountId: string;
  labelsAdded: string[];
  labelsRemoved: string[];
}

interface MailLabelUpdatedEvent {
  slug: string;
  accountId: string;
  totalCount: number;
  unreadCount: number;
}

// ============================================================================
// TYPES
// ============================================================================

export interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  provider: string;
  unreadCount: number;
  totalMessages: number;
  isDefault: boolean;
  isActive: boolean;
  isShared?: boolean;
  assignedUserIds?: string[];
  lastSyncedAt?: string;
  signature?: string;
}

export interface EmailLabel {
  id: string;
  slug: string;
  name: string;
  color?: string;
  isSystem: boolean;
  unreadCount?: number;
  totalCount?: number;
}

export interface Email {
  id: string;
  emailAccountId: string;
  from: string;
  fromName?: string;
  fromEmail: string;
  subject: string;
  preview?: string;
  date: string;
  time: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  labels: string[];
  category: 'primary' | 'social' | 'promotions' | 'updates';
}

export interface EmailDetail extends Email {
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  body?: string;
  bodyHtml?: string;
  sentAt?: string;
  receivedAt: string;
  attachments: EmailAttachment[];
  threadId?: string;
  inReplyTo?: string;
  isDraft: boolean;
  isSent: boolean;
  importance: string;
  labels?: string[];
}

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  downloadUrl?: string;
}

export interface EmailStats {
  totalUnread: number;
  inboxCount: number;
  inboxUnread: number;
  sentCount: number;
  draftCount: number;
  trashCount: number;
  spamCount: number;
  archivedCount: number;
  starredCount: number;
}

export interface ThreadMessage {
  id: string;
  from: any;
  to: any;
  cc?: any;
  subject?: string;
  preview?: string;
  textBody?: string;
  htmlBody?: string;
  sentDate?: string;
  receivedDate?: string;
  isRead: boolean;
  hasAttachments: boolean;
  labels?: string[];
  date?: string;
  time?: string;
}

export interface SendEmailRequest {
  emailAccountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  threadId?: string;
  attachmentIds?: string[];
  saveToDrafts?: boolean;
  draftId?: string;
}

export interface ScheduleEmailRequest {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  scheduledFor: string;
  inReplyTo?: string;
  references?: string[];
  attachmentIds?: string[];
}

export interface MessageFilters {
  accountId?: string;
  label?: string;
  search?: string;
  isRead?: boolean;
  isStarred?: boolean;
}

interface MailOfflineAction {
  id: string;
  type: 'mark_read' | 'toggle_star' | 'delete' | 'archive' | 'send_email' | 'add_label' | 'remove_label';
  payload: any;
  timestamp: number;
}

interface MailState {
  // Data
  accounts: EmailAccount[];
  selectedAccount: EmailAccount | null;
  labels: EmailLabel[];
  selectedLabel: EmailLabel | null;
  messages: Email[];
  currentMessage: EmailDetail | null;
  threadMessages: ThreadMessage[];
  stats: EmailStats | null;

  // Pagination
  currentPage: number;
  hasMore: boolean;
  totalMessages: number;

  // Cache timestamps
  lastAccountsUpdate: number | null;
  lastLabelsUpdate: number | null;
  lastMessagesUpdate: number | null;

  // Loading states
  loading: {
    accounts: boolean;
    labels: boolean;
    messages: boolean;
    message: boolean;
    thread: boolean;
    sending: boolean;
    stats: boolean;
  };

  // Errors
  errors: {
    accounts: string | null;
    labels: string | null;
    messages: string | null;
    message: string | null;
    thread: string | null;
    sending: string | null;
  };

  // Offline queue
  offlineQueue: MailOfflineAction[];

  // Connection state
  isConnected: boolean;

  // Realtime connection state
  realtimeState: ConnectionState;
}

interface MailContextValue extends MailState {
  // Account management
  loadAccounts: (force?: boolean) => Promise<void>;
  selectAccount: (account: EmailAccount) => void;

  // Label management
  loadLabels: (accountId: string, force?: boolean) => Promise<void>;
  selectLabel: (label: EmailLabel) => void;

  // Message management
  loadMessages: (filters?: MessageFilters, force?: boolean) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessage: (id: string) => Promise<EmailDetail | null>;
  loadThread: (messageId: string) => Promise<ThreadMessage[]>;
  refreshMessages: () => Promise<void>;

  // Message actions
  markAsRead: (id: string, isRead: boolean) => Promise<boolean>;
  toggleStar: (id: string) => Promise<boolean>;
  deleteMessage: (id: string) => Promise<boolean>;
  archiveMessage: (id: string) => Promise<boolean>;

  // Compose
  sendEmail: (request: SendEmailRequest) => Promise<boolean>;
  saveDraft: (request: SendEmailRequest) => Promise<string | null>;
  scheduleEmail: (request: ScheduleEmailRequest) => Promise<boolean>;

  // Stats
  loadStats: (accountId?: string) => Promise<void>;

  // Cache management
  clearCache: () => Promise<void>;
  isDataStale: (lastUpdate: number | null, maxAge?: number) => boolean;

  // Offline queue
  addToOfflineQueue: (action: Omit<MailOfflineAction, 'id' | 'timestamp'>) => Promise<void>;
  processOfflineQueue: () => Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEYS = {
  ACCOUNTS: '@mail_accounts',
  LABELS: '@mail_labels',
  MESSAGES: '@mail_messages',
  STATS: '@mail_stats',
  OFFLINE_QUEUE: '@mail_offline_queue',
  SELECTED_ACCOUNT: '@mail_selected_account',
};

const CACHE_DURATION = {
  ACCOUNTS: 30 * 60 * 1000,   // 30 minutes
  LABELS: 10 * 60 * 1000,     // 10 minutes
  MESSAGES: 2 * 60 * 1000,    // 2 minutes
  STATS: 5 * 60 * 1000,       // 5 minutes
};

const PAGE_SIZE = 20;

// ============================================================================
// CONTEXT
// ============================================================================

const MailContext = createContext<MailContextValue | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

export function MailProvider({ children }: { children: ReactNode }) {
  const { user, isSignedIn } = useClerkAuth();
  const [state, setState] = useState<MailState>({
    accounts: [],
    selectedAccount: null,
    labels: [],
    selectedLabel: null,
    messages: [],
    currentMessage: null,
    threadMessages: [],
    stats: null,
    currentPage: 1,
    hasMore: true,
    totalMessages: 0,
    lastAccountsUpdate: null,
    lastLabelsUpdate: null,
    lastMessagesUpdate: null,
    loading: {
      accounts: false,
      labels: false,
      messages: false,
      message: false,
      thread: false,
      sending: false,
      stats: false,
    },
    errors: {
      accounts: null,
      labels: null,
      messages: null,
      message: null,
      thread: null,
      sending: null,
    },
    offlineQueue: [],
    isConnected: true,
    realtimeState: 'disconnected',
  });

  // Monitor network connectivity
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(networkState => {
      const connected = networkState.isConnected ?? true;
      setState(prev => ({ ...prev, isConnected: connected }));

      // Process offline queue when back online
      if (connected && state.offlineQueue.length > 0) {
        processOfflineQueue();
      }
    });

    return () => unsubscribe();
  }, [state.offlineQueue.length]);

  // Load offline queue on mount
  useEffect(() => {
    const loadOfflineQueue = async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
        if (stored) {
          setState(prev => ({ ...prev, offlineQueue: JSON.parse(stored) }));
        }
      } catch (error) {
        console.error('Failed to load offline queue:', error);
      }
    };
    loadOfflineQueue();
  }, []);

  // Subscribe to in-house realtime mail events for the current user
  const realtimeClient = useWorkspaceClientMaybe();
  useEffect(() => {
    if (!realtimeClient || !isSignedIn || !user?.id) return;

    const mailTopic = topics.mail(user.id);

    // Handler for new emails
    const offNew = realtimeClient.on(`${mailTopic}.new`, (event: any) => {
      const e: MailNewEmailEvent = event.data ?? event;
      setState(prev => {
        const exists = prev.messages.some(m => m.id === e.id);
        if (exists) return prev;

        const matchesAccount = !prev.selectedAccount || e.accountId === prev.selectedAccount.id;
        const matchesLabel = !prev.selectedLabel || e.labels?.includes(prev.selectedLabel.slug);
        if (!matchesAccount || !matchesLabel) return prev;

        const newEmail: Email = {
          id: e.id,
          emailAccountId: e.accountId,
          from: e.from.name || e.from.email,
          fromName: e.from.name,
          fromEmail: e.from.email,
          subject: e.subject,
          preview: e.preview,
          date: new Date(e.receivedDate).toLocaleDateString(),
          time: new Date(e.receivedDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isRead: e.isRead,
          isStarred: e.isStarred,
          hasAttachment: e.hasAttachments,
          labels: e.labels || ['INBOX'],
          category: 'primary',
        };

        return {
          ...prev,
          messages: [newEmail, ...prev.messages],
          totalMessages: prev.totalMessages + 1,
        };
      });
    });

    const offRead = realtimeClient.on(`${mailTopic}.read`, (event: any) => {
      const e: MailReadEvent = event.data ?? event;
      setState(prev => ({
        ...prev,
        messages: prev.messages.map(m => m.id === e.id ? { ...m, isRead: e.isRead } : m),
      }));
    });

    const offStarred = realtimeClient.on(`${mailTopic}.starred`, (event: any) => {
      const e: MailStarredEvent = event.data ?? event;
      setState(prev => ({
        ...prev,
        messages: prev.messages.map(m => m.id === e.id ? { ...m, isStarred: e.isStarred } : m),
      }));
    });

    const offDeleted = realtimeClient.on(`${mailTopic}.deleted`, (event: any) => {
      const e: MailDeletedEvent = event.data ?? event;
      setState(prev => ({
        ...prev,
        messages: prev.messages.filter(m => m.id !== e.id),
        totalMessages: Math.max(0, prev.totalMessages - 1),
      }));
    });

    const offArchived = realtimeClient.on(`${mailTopic}.archived`, (event: any) => {
      const e: MailArchivedEvent = event.data ?? event;
      setState(prev => {
        const inboxRemoved = e.labelsRemoved?.includes('INBOX');
        if (prev.selectedLabel?.slug === 'INBOX' && inboxRemoved) {
          return {
            ...prev,
            messages: prev.messages.filter(m => m.id !== e.id),
            totalMessages: Math.max(0, prev.totalMessages - 1),
          };
        }
        return prev;
      });
    });

    const offLabelUpdated = realtimeClient.on(`${mailTopic}.label_updated`, (event: any) => {
      const e: MailLabelUpdatedEvent = event.data ?? event;
      setState(prev => ({
        ...prev,
        labels: prev.labels.map(l =>
          l.slug === e.slug ? { ...l, totalCount: e.totalCount, unreadCount: e.unreadCount } : l
        ),
      }));
    });

    const offConn = realtimeClient.onConnectionChange((newState) => {
      setState(prev => ({ ...prev, realtimeState: newState }));
    });

    return () => {
      offNew();
      offRead();
      offStarred();
      offDeleted();
      offArchived();
      offLabelUpdated();
      offConn();
    };
  }, [realtimeClient, isSignedIn, user?.id]);

  // Utility function to check if data is stale
  const isDataStale = useCallback((lastUpdate: number | null, maxAge: number = CACHE_DURATION.MESSAGES): boolean => {
    if (!lastUpdate) return true;
    return Date.now() - lastUpdate > maxAge;
  }, []);

  // ============================================================================
  // ACCOUNTS
  // ============================================================================

  const loadAccounts = useCallback(async (force: boolean = false) => {
    if (!force && !isDataStale(state.lastAccountsUpdate, CACHE_DURATION.ACCOUNTS)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, accounts: true },
      errors: { ...prev.errors, accounts: null },
    }));

    try {
      const response = await api.getEmailAccounts();
      if (response.success && response.data) {
        const accounts = Array.isArray(response.data) ? response.data : [];

        // Try to restore previously selected account from AsyncStorage
        let restoredAccount: EmailAccount | null = null;
        try {
          const savedAccountId = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ACCOUNT);
          if (savedAccountId) {
            restoredAccount = accounts.find((a: EmailAccount) => a.id === savedAccountId) || null;
          }
        } catch {
          // Ignore AsyncStorage errors
        }

        setState(prev => ({
          ...prev,
          accounts,
          lastAccountsUpdate: Date.now(),
          loading: { ...prev.loading, accounts: false },
          // Restore saved account, then fall back to default, then first
          selectedAccount: prev.selectedAccount || restoredAccount || accounts.find((a: EmailAccount) => a.isDefault) || accounts[0] || null,
        }));
        await AsyncStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(accounts));
      } else {
        throw new Error(response.error || 'Failed to load accounts');
      }
    } catch (error) {
      console.error('Failed to load accounts:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, accounts: false },
        errors: { ...prev.errors, accounts: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastAccountsUpdate, isDataStale]);

  const selectAccount = useCallback((account: EmailAccount) => {
    setState(prev => ({
      ...prev,
      selectedAccount: account,
      labels: [],
      messages: [],
      currentPage: 1,
      lastLabelsUpdate: null,
      lastMessagesUpdate: null,
    }));
    AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ACCOUNT, account.id);
  }, []);

  // ============================================================================
  // LABELS
  // ============================================================================

  const loadLabels = useCallback(async (accountId: string, force: boolean = false) => {
    if (!force && !isDataStale(state.lastLabelsUpdate, CACHE_DURATION.LABELS)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, labels: true },
      errors: { ...prev.errors, labels: null },
    }));

    try {
      const response = await api.getLabels(accountId);
      if (response.success && response.data) {
        const labels = Array.isArray(response.data) ? response.data : [];
        setState(prev => ({
          ...prev,
          labels,
          lastLabelsUpdate: Date.now(),
          loading: { ...prev.loading, labels: false },
          // Auto-select INBOX if none selected
          selectedLabel: prev.selectedLabel || labels.find((l: EmailLabel) => l.slug === 'INBOX') || labels[0] || null,
        }));
      } else {
        throw new Error(response.error || 'Failed to load labels');
      }
    } catch (error) {
      console.error('Failed to load labels:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, labels: false },
        errors: { ...prev.errors, labels: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastLabelsUpdate, isDataStale]);

  const selectLabel = useCallback((label: EmailLabel) => {
    setState(prev => ({
      ...prev,
      selectedLabel: label,
      messages: [],
      currentPage: 1,
      lastMessagesUpdate: null,
    }));
  }, []);

  // ============================================================================
  // MESSAGES
  // ============================================================================

  const loadMessages = useCallback(async (filters?: MessageFilters, force: boolean = false) => {
    if (!force && !isDataStale(state.lastMessagesUpdate, CACHE_DURATION.MESSAGES)) {
      return;
    }

    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, messages: true },
      errors: { ...prev.errors, messages: null },
    }));

    try {
      const accountId = filters?.accountId || state.selectedAccount?.id;
      const label = filters?.label || state.selectedLabel?.slug || 'INBOX';

      // Drafts are stored in a separate table — use the dedicated endpoint
      if (label === 'DRAFTS' && accountId) {
        const response = await api.getDrafts(accountId, 1, PAGE_SIZE);
        if (response.success) {
          const drafts = response.data || [];
          const messages = drafts.map((d: any) => ({
            id: d.id,
            subject: d.subject || '(No subject)',
            from: 'Me',
            to: Array.isArray(d.to) ? d.to.join(', ') : d.to || '',
            preview: d.body?.replace(/<[^>]*>/g, '').slice(0, 200) || '',
            body: d.htmlBody || d.body || '',
            date: d.updatedAt || d.createdAt,
            isRead: true,
            isStarred: false,
            hasAttachments: d.hasAttachments || false,
            labels: d.labels || ['DRAFTS'],
            accountId: d.accountId,
          }));
          const total = response.pagination?.total || messages.length;
          setState(prev => ({
            ...prev,
            messages,
            totalMessages: total,
            currentPage: 1,
            hasMore: messages.length >= PAGE_SIZE,
            lastMessagesUpdate: Date.now(),
            loading: { ...prev.loading, messages: false },
          }));
        } else {
          throw new Error(response.error || 'Failed to load drafts');
        }
      } else {
        const response = await api.getMessages({
          emailAccountId: accountId,
          label,
          search: filters?.search,
          isRead: filters?.isRead,
          isStarred: filters?.isStarred,
          page: 1,
          limit: PAGE_SIZE,
        });

        if (response.success && response.data) {
          const messages = response.data.items || [];
          const total = response.data.meta?.total || messages.length;
          setState(prev => ({
            ...prev,
            messages,
            totalMessages: total,
            currentPage: 1,
            hasMore: messages.length >= PAGE_SIZE,
            lastMessagesUpdate: Date.now(),
            loading: { ...prev.loading, messages: false },
          }));
        } else {
          throw new Error(response.error || 'Failed to load messages');
        }
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, messages: false },
        errors: { ...prev.errors, messages: error instanceof Error ? error.message : 'Unknown error' },
      }));
    }
  }, [state.lastMessagesUpdate, state.selectedAccount, state.selectedLabel, isDataStale]);

  const loadMoreMessages = useCallback(async () => {
    if (!state.hasMore || state.loading.messages) return;

    const nextPage = state.currentPage + 1;
    const accountId = state.selectedAccount?.id;
    const label = state.selectedLabel?.slug || 'INBOX';

    try {
      const response = await api.getMessages({
        emailAccountId: accountId,
        label,
        page: nextPage,
        limit: PAGE_SIZE,
      });

      if (response.success && response.data) {
        const newMessages = response.data.items || [];
        setState(prev => ({
          ...prev,
          messages: [...prev.messages, ...newMessages],
          currentPage: nextPage,
          hasMore: newMessages.length >= PAGE_SIZE,
        }));
      }
    } catch (error) {
      console.error('Failed to load more messages:', error);
    }
  }, [state.currentPage, state.hasMore, state.loading.messages, state.selectedAccount, state.selectedLabel]);

  const loadMessage = useCallback(async (id: string): Promise<EmailDetail | null> => {
    setState(prev => ({
      ...prev,
      threadMessages: [],
      loading: { ...prev.loading, message: true },
      errors: { ...prev.errors, message: null },
    }));

    try {
      // Drafts are stored in a separate table — use the dedicated endpoint
      const response = id.startsWith('draft_')
        ? await api.getDraft(id)
        : await api.getMessage(id);
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          currentMessage: response.data,
          loading: { ...prev.loading, message: false },
        }));
        return response.data;
      } else {
        throw new Error(response.error || 'Failed to load message');
      }
    } catch (error) {
      console.error('Failed to load message:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, message: false },
        errors: { ...prev.errors, message: error instanceof Error ? error.message : 'Unknown error' },
      }));
      return null;
    }
  }, []);

  const loadThread = useCallback(async (messageId: string): Promise<ThreadMessage[]> => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, thread: true },
      errors: { ...prev.errors, thread: null },
    }));

    try {
      const response = await api.getThread(messageId);
      if (response.success && response.data) {
        const threadMessages = Array.isArray(response.data) ? response.data : [];
        setState(prev => ({
          ...prev,
          threadMessages,
          loading: { ...prev.loading, thread: false },
        }));
        return threadMessages;
      } else {
        setState(prev => ({
          ...prev,
          loading: { ...prev.loading, thread: false },
        }));
        return [];
      }
    } catch (error) {
      console.error('Failed to load thread:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, thread: false },
        errors: { ...prev.errors, thread: error instanceof Error ? error.message : 'Unknown error' },
      }));
      return [];
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    await loadMessages({}, true);
  }, [loadMessages]);

  // ============================================================================
  // MESSAGE ACTIONS
  // ============================================================================

  const markAsRead = useCallback(async (id: string, isRead: boolean): Promise<boolean> => {
    // Optimistic update
    setState(prev => ({
      ...prev,
      messages: prev.messages.map(m => m.id === id ? { ...m, isRead } : m),
    }));

    try {
      const response = await api.markAsRead(id, isRead);
      if (response.success) {
        return true;
      }
      // Revert on failure
      setState(prev => ({
        ...prev,
        messages: prev.messages.map(m => m.id === id ? { ...m, isRead: !isRead } : m),
      }));
      return false;
    } catch (error) {
      console.error('Failed to mark as read:', error);
      // Add to offline queue
      await addToOfflineQueue({ type: 'mark_read', payload: { id, isRead } });
      return false;
    }
  }, []);

  const toggleStar = useCallback(async (id: string): Promise<boolean> => {
    // Find current state
    const message = state.messages.find(m => m.id === id);
    const newStarred = !message?.isStarred;

    // Optimistic update
    setState(prev => ({
      ...prev,
      messages: prev.messages.map(m => m.id === id ? { ...m, isStarred: newStarred } : m),
    }));

    try {
      const response = await api.toggleStar(id);
      if (response.success) {
        return true;
      }
      // Revert on failure
      setState(prev => ({
        ...prev,
        messages: prev.messages.map(m => m.id === id ? { ...m, isStarred: !newStarred } : m),
      }));
      return false;
    } catch (error) {
      console.error('Failed to toggle star:', error);
      await addToOfflineQueue({ type: 'toggle_star', payload: { id } });
      return false;
    }
  }, [state.messages]);

  const deleteMessage = useCallback(async (id: string): Promise<boolean> => {
    // Optimistic update - remove from list
    const deletedMessage = state.messages.find(m => m.id === id);
    setState(prev => ({
      ...prev,
      messages: prev.messages.filter(m => m.id !== id),
    }));

    try {
      const response = await api.deleteEmail(id);
      if (response.success) {
        return true;
      }
      // Revert on failure
      if (deletedMessage) {
        setState(prev => ({
          ...prev,
          messages: [...prev.messages, deletedMessage].sort((a, b) =>
            new Date(b.date + ' ' + b.time).getTime() - new Date(a.date + ' ' + a.time).getTime()
          ),
        }));
      }
      return false;
    } catch (error) {
      console.error('Failed to delete message:', error);
      await addToOfflineQueue({ type: 'delete', payload: { id } });
      return false;
    }
  }, [state.messages]);

  const archiveMessage = useCallback(async (id: string): Promise<boolean> => {
    // Optimistic update - remove from current label view
    const archivedMessage = state.messages.find(m => m.id === id);
    setState(prev => ({
      ...prev,
      messages: prev.messages.filter(m => m.id !== id),
    }));

    try {
      const response = await api.archiveEmail(id);
      if (response.success) {
        return true;
      }
      // Revert on failure
      if (archivedMessage) {
        setState(prev => ({
          ...prev,
          messages: [...prev.messages, archivedMessage].sort((a, b) =>
            new Date(b.date + ' ' + b.time).getTime() - new Date(a.date + ' ' + a.time).getTime()
          ),
        }));
      }
      return false;
    } catch (error) {
      console.error('Failed to archive message:', error);
      await addToOfflineQueue({ type: 'archive', payload: { id } });
      return false;
    }
  }, [state.messages]);

  // ============================================================================
  // COMPOSE
  // ============================================================================

  const sendEmail = useCallback(async (request: SendEmailRequest): Promise<boolean> => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, sending: true },
      errors: { ...prev.errors, sending: null },
    }));

    try {
      const response = await api.sendEmail(request);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, sending: false },
      }));

      if (response.success) {
        // Refresh messages in background — don't block the send result
        refreshMessages().catch(err => console.warn('Failed to refresh after send:', err));
        return true;
      }
      console.warn('Send email failed:', response.error);
      return false;
    } catch (error) {
      console.error('Failed to send email:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, sending: false },
        errors: { ...prev.errors, sending: error instanceof Error ? error.message : 'Unknown error' },
      }));
      // Add to offline queue for retry
      await addToOfflineQueue({ type: 'send_email', payload: request });
      return false;
    }
  }, [refreshMessages]);

  const saveDraft = useCallback(async (request: SendEmailRequest): Promise<string | null> => {
    try {
      const response = await api.sendEmail({ ...request, saveToDrafts: true });
      if (response.success && response.data?.draftId) {
        return response.data.draftId;
      }
      return null;
    } catch (error) {
      console.error('Failed to save draft:', error);
      return null;
    }
  }, []);

  const scheduleEmail = useCallback(async (request: ScheduleEmailRequest): Promise<boolean> => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, sending: true },
      errors: { ...prev.errors, sending: null },
    }));

    try {
      const response = await api.scheduleEmail(request);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, sending: false },
      }));

      if (response.success) {
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to schedule email:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, sending: false },
        errors: { ...prev.errors, sending: error instanceof Error ? error.message : 'Unknown error' },
      }));
      return false;
    }
  }, []);

  // ============================================================================
  // STATS
  // ============================================================================

  const loadStats = useCallback(async (accountId?: string) => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, stats: true },
    }));

    try {
      const response = await api.getEmailStats(accountId);
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          stats: response.data,
          loading: { ...prev.loading, stats: false },
        }));
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, stats: false },
      }));
    }
  }, []);

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  const clearCache = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem(STORAGE_KEYS.ACCOUNTS),
      AsyncStorage.removeItem(STORAGE_KEYS.LABELS),
      AsyncStorage.removeItem(STORAGE_KEYS.MESSAGES),
      AsyncStorage.removeItem(STORAGE_KEYS.STATS),
    ]);

    setState(prev => ({
      ...prev,
      accounts: [],
      labels: [],
      messages: [],
      stats: null,
      currentMessage: null,
      threadMessages: [],
      lastAccountsUpdate: null,
      lastLabelsUpdate: null,
      lastMessagesUpdate: null,
    }));
  }, []);

  // ============================================================================
  // OFFLINE QUEUE
  // ============================================================================

  const addToOfflineQueue = useCallback(async (action: Omit<MailOfflineAction, 'id' | 'timestamp'>) => {
    const newAction: MailOfflineAction = {
      ...action,
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    setState(prev => ({
      ...prev,
      offlineQueue: [...prev.offlineQueue, newAction],
    }));

    const updatedQueue = [...state.offlineQueue, newAction];
    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(updatedQueue));
  }, [state.offlineQueue]);

  const processOfflineQueue = useCallback(async () => {
    if (state.offlineQueue.length === 0) return;

    const queue = [...state.offlineQueue];
    const failedActions: MailOfflineAction[] = [];

    for (const action of queue) {
      try {
        switch (action.type) {
          case 'mark_read':
            await api.markAsRead(action.payload.id, action.payload.isRead);
            break;
          case 'toggle_star':
            await api.toggleStar(action.payload.id);
            break;
          case 'delete':
            await api.deleteEmail(action.payload.id);
            break;
          case 'archive':
            await api.archiveEmail(action.payload.id);
            break;
          case 'send_email':
            await api.sendEmail(action.payload);
            break;
        }
      } catch (error) {
        console.error(`Failed to process offline action ${action.type}:`, error);
        failedActions.push(action);
      }
    }

    setState(prev => ({
      ...prev,
      offlineQueue: failedActions,
    }));

    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(failedActions));

    // Refresh data after processing queue
    if (failedActions.length < queue.length) {
      await loadMessages({}, true);
    }
  }, [state.offlineQueue, loadMessages]);

  // ============================================================================
  // CONTEXT VALUE
  // ============================================================================

  const value: MailContextValue = {
    ...state,
    loadAccounts,
    selectAccount,
    loadLabels,
    selectLabel,
    loadMessages,
    loadMoreMessages,
    loadMessage,
    loadThread,
    refreshMessages,
    markAsRead,
    toggleStar,
    deleteMessage,
    archiveMessage,
    sendEmail,
    saveDraft,
    scheduleEmail,
    loadStats,
    clearCache,
    isDataStale,
    addToOfflineQueue,
    processOfflineQueue,
  };

  return <MailContext.Provider value={value}>{children}</MailContext.Provider>;
}

// ============================================================================
// HOOK
// ============================================================================

export function useMail() {
  const context = useContext(MailContext);
  if (context === undefined) {
    throw new Error('useMail must be used within a MailProvider');
  }
  return context;
}

export default MailContext;
