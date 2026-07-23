
import React, { useState, useMemo } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { Star, Pin, Archive, Trash2, Tag, Clock, Calendar as CalendarIcon, X, Reply, ReplyAll, Forward, Paperclip, Search, ExternalLink, FolderInput, BellOff, ListChecks, Eye, EyeOff, Inbox, AlertCircle } from 'lucide-react';
import { usePinnedMessagesSafe } from '@/contexts/pinned-messages-context';
import { useStarredMessagesSafe } from '@/contexts/starred-messages-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '@weldsuite/ui/components/context-menu';
import { cn } from '@/lib/utils';
import { format, addHours, addDays, setHours, setMinutes, nextMonday } from 'date-fns';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { mailApi } from '../lib/api-client';
import type { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';
import type { ThreadSummary } from '../lib/thread-utils';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import { formatParticipants as formatParticipantsUtil } from '@/components/shared/conversation-list';
import {
  useArchiveThread,
  useTrashThread,
  useMarkThreadAsRead,
  useMarkThreadAsSpam,
  useUpdateThreadLabels,
  useArchiveMailMessage,
  useMoveToTrash,
  useMarkMailRead,
  useMarkAsSpam,
  useUpdateMessageLabels,
  useSnoozeEmail,
  useMailLabels,
  useBulkMailAction,
} from '@/hooks/queries/use-mail-queries';
import { useCreateTask } from '@/hooks/queries/use-task-queries';
import { useI18n } from '@/lib/i18n/provider';

type EmailMessage = MailTypes.Email;

function threadToConversationItem(thread: ThreadSummary, isUnified?: boolean, scheduledLabel?: (date: string) => string): ConversationItem {
  const name = thread.latestSender || 'Unknown';

  const isScheduled = thread.sendStatus === 'scheduled' && thread.scheduledFor;

  return {
    id: thread.threadId,
    name,
    email: thread.latestSenderEmail,
    avatarUrl: thread.latestSenderAvatarUrl ?? undefined,
    subject: thread.subject,
    preview: isScheduled
      ? (scheduledLabel ? scheduledLabel(format(new Date(thread.scheduledFor!), 'PPp')) : `Scheduled for ${format(new Date(thread.scheduledFor!), 'PPp')}`)
      : isUnified && thread.accountEmail
        ? `[${thread.accountEmail}] ${thread.preview}`
        : thread.preview,
    date: new Date(thread.latestDate),
    isRead: thread.unreadCount === 0,
    isStarred: thread.isStarred,
    hasAttachments: thread.hasAttachments,
    labels: isScheduled
      ? [...thread.labels, 'scheduled']
      : thread.labels,
    messageCount: thread.messageCount,
    unreadCount: thread.unreadCount,
    // Store extra fields for URL generation and context menu actions
    _latestMessageId: thread.latestMessageId,
    _accountId: thread.accountId,
    _accountEmail: thread.accountEmail,
  } as ConversationItem & { _latestMessageId: string; _accountId?: string; _accountEmail?: string };
}

function emailToConversationItem(email: EmailMessage, scheduledLabel?: (date: string) => string): ConversationItem {
  const isScheduled = email.sendStatus === 'scheduled' && email.scheduledFor;
  // `from` can be either a string ("Name <email>") or an EmailAddress object
  // with an `avatarUrl` field projected by the api-worker mail list route.
  const fromAvatar =
    typeof email.from === 'object' && email.from !== null
      ? ((email.from as { avatarUrl?: string | null }).avatarUrl ?? undefined)
      : undefined;

  return {
    id: email.id,
    name: email.fromEmail || (typeof email.from === 'string' ? email.from : email.from?.name) || 'Unknown',
    email: email.fromEmail,
    avatarUrl: fromAvatar,
    subject: email.subject || '',
    preview: isScheduled
      ? (scheduledLabel ? scheduledLabel(format(new Date(email.scheduledFor), 'PPp')) : `Scheduled for ${format(new Date(email.scheduledFor), 'PPp')}`)
      : email.preview || email.bodyText?.slice(0, 100) || '',
    date: new Date(email.date),
    isRead: email.isRead,
    isStarred: email.isStarred,
    hasAttachments: email.hasAttachments,
    labels: isScheduled
      ? [...(email.labels || []), 'scheduled']
      : email.labels || [],
    messageCount: 1,
    unreadCount: email.isRead ? 0 : 1,
  };
}

// ---- Gmail-style mail filter -------------------------------------------------
// The Filter button opens a Gmail-like form (From / To / Subject / Has the words /
// Doesn't have / Size / Date within / Has attachment). The form is a *draft* that
// is applied to the visible list only when the user clicks Search.

type MailFilterSizeOp = 'gt' | 'lt';
type MailFilterSizeUnit = 'bytes' | 'kb' | 'mb';
type MailFilterDateWithin = '1d' | '3d' | '1w' | '2w' | '1m' | '2m' | '6m' | '1y';

interface MailFilter {
  from?: string;
  to?: string;
  subject?: string;
  hasWords?: string;
  doesntHave?: string;
  sizeOp?: MailFilterSizeOp;
  sizeValue?: string;
  sizeUnit?: MailFilterSizeUnit;
  dateWithin?: MailFilterDateWithin;
  dateWithinDate?: Date;
  hasAttachment?: boolean;
}

const SIZE_UNIT_BYTES: Record<MailFilterSizeUnit, number> = { bytes: 1, kb: 1024, mb: 1024 * 1024 };
const DATE_WITHIN_DAYS: Record<MailFilterDateWithin, number> = {
  '1d': 1, '3d': 3, '1w': 7, '2w': 14, '1m': 30, '2m': 60, '6m': 180, '1y': 365,
};

function mailFilterHasSize(f: MailFilter): boolean {
  return !!f.sizeValue && Number(f.sizeValue) > 0;
}
function mailFilterHasDate(f: MailFilter): boolean {
  return !!f.dateWithin && !!f.dateWithinDate;
}

function countActiveFilters(f: MailFilter): number {
  let n = 0;
  if (f.from?.trim()) n++;
  if (f.to?.trim()) n++;
  if (f.subject?.trim()) n++;
  if (f.hasWords?.trim()) n++;
  if (f.doesntHave?.trim()) n++;
  if (mailFilterHasSize(f)) n++;
  if (mailFilterHasDate(f)) n++;
  if (f.hasAttachment) n++;
  return n;
}

// Flatten a `from`/`to` value (string, EmailAddress object, or an array of either)
// into a single searchable string of names + emails.
function addressToText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(addressToText).join(' ');
  const obj = value as { name?: string; email?: string };
  return [obj.name, obj.email].filter(Boolean).join(' ');
}

// Space-separated terms are ANDed (Gmail behaviour); empty query matches everything.
function includesAllTokens(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const h = haystack.toLowerCase();
  return tokens.every((tok) => h.includes(tok));
}
function includesAnyToken(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const h = haystack.toLowerCase();
  return tokens.some((tok) => h.includes(tok));
}

function sizeMatches(bytes: number | null | undefined, f: MailFilter): boolean {
  if (!mailFilterHasSize(f)) return true;
  if (bytes == null) return false;
  const threshold = Number(f.sizeValue) * SIZE_UNIT_BYTES[f.sizeUnit ?? 'mb'];
  return (f.sizeOp ?? 'gt') === 'lt' ? bytes < threshold : bytes > threshold;
}

function dateWithinMatches(date: Date | null | undefined, f: MailFilter): boolean {
  if (!mailFilterHasDate(f)) return true;
  if (!date) return false;
  const days = DATE_WITHIN_DAYS[f.dateWithin!];
  const diff = Math.abs(date.getTime() - f.dateWithinDate!.getTime());
  return diff <= days * 24 * 60 * 60 * 1000;
}

function threadMatchesFilter(thread: ThreadSummary, f: MailFilter): boolean {
  if (countActiveFilters(f) === 0) return true;
  if (f.hasAttachment && !thread.hasAttachments) return false;

  const msgs = (thread.messages ?? []) as Array<Record<string, unknown>>;
  const fromText = [thread.latestSender, thread.latestSenderEmail, ...(thread.participants ?? []), ...msgs.map((m) => addressToText(m.from))].join(' ');
  if (f.from?.trim() && !includesAllTokens(fromText, f.from)) return false;

  if (f.to?.trim()) {
    const toText = msgs.map((m) => addressToText(m.to)).join(' ');
    if (!includesAllTokens(toText, f.to)) return false;
  }

  if (f.subject?.trim() && !includesAllTokens(thread.subject ?? '', f.subject)) return false;

  if (f.hasWords?.trim() || f.doesntHave?.trim()) {
    const blob = [thread.subject, thread.preview, fromText, ...msgs.map((m) => `${(m.preview as string) ?? ''} ${(m.textBody as string) ?? ''} ${(m.subject as string) ?? ''}`)].join(' ');
    if (f.hasWords?.trim() && !includesAllTokens(blob, f.hasWords)) return false;
    if (f.doesntHave?.trim() && includesAnyToken(blob, f.doesntHave)) return false;
  }

  if (mailFilterHasSize(f)) {
    const maxSize = msgs.reduce((mx, m) => Math.max(mx, (m.sizeBytes as number) ?? 0), 0);
    if (!sizeMatches(maxSize || null, f)) return false;
  }

  if (mailFilterHasDate(f) && !dateWithinMatches(thread.latestDate ? new Date(thread.latestDate) : null, f)) return false;

  return true;
}

function messageMatchesFilter(message: EmailMessage, f: MailFilter): boolean {
  if (countActiveFilters(f) === 0) return true;
  if (f.hasAttachment && !message.hasAttachments) return false;

  const fromText = [message.fromEmail, addressToText(message.from)].filter(Boolean).join(' ');
  if (f.from?.trim() && !includesAllTokens(fromText, f.from)) return false;

  const toText = addressToText(message.to as unknown);
  if (f.to?.trim() && !includesAllTokens(toText, f.to)) return false;

  if (f.subject?.trim() && !includesAllTokens(message.subject ?? '', f.subject)) return false;

  if (f.hasWords?.trim() || f.doesntHave?.trim()) {
    const blob = [message.subject, message.preview, message.bodyText, fromText, toText].filter(Boolean).join(' ');
    if (f.hasWords?.trim() && !includesAllTokens(blob, f.hasWords)) return false;
    if (f.doesntHave?.trim() && includesAnyToken(blob, f.doesntHave)) return false;
  }

  if (mailFilterHasSize(f) && !sizeMatches((message.size as number | undefined) ?? null, f)) return false;

  if (mailFilterHasDate(f) && !dateWithinMatches(message.date ? new Date(message.date) : null, f)) return false;

  return true;
}

interface MessageListProps {
  messages?: EmailMessage[];
  threads?: ThreadSummary[];
  accountId: string;
  folder: string;
  selectedMessageId?: string;
  error?: string | null;
  currentPage?: number;
  totalPages?: number;
  totalCount?: number;
  pageSize?: number;
  isUnified?: boolean;
  onThreadLabelUpdate?: (threadId: string, labelName: string, action: 'add' | 'remove') => void;
}

export function MessageList({
  messages = [],
  threads,
  accountId,
  folder,
  selectedMessageId: propSelectedMessageId,
  error,
  currentPage = 1,
  totalPages = 1,
  totalCount = 0,
  pageSize = 25,
  isUnified = false,
  onThreadLabelUpdate,
}: MessageListProps) {
  const { t } = useI18n();
  const displayMode = threads ? 'threads' : 'messages';
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const selectedMessageId = (params?.messageId as string) || propSelectedMessageId;
  const archiveThread = useArchiveThread();
  const trashThread = useTrashThread();
  const markThreadAsRead = useMarkThreadAsRead();
  const markThreadAsSpam = useMarkThreadAsSpam();
  const updateThreadLabels = useUpdateThreadLabels();
  const archiveMessage = useArchiveMailMessage();
  const trashMessage = useMoveToTrash();
  const markMailRead = useMarkMailRead();
  const markAsSpam = useMarkAsSpam();
  const snoozeEmail = useSnoozeEmail();
  const bulkAction = useBulkMailAction();
  const createTask = useCreateTask();
  const { data: labelsData } = useMailLabels(isUnified ? undefined : accountId, !isUnified && !!accountId);
  const mailLabels = (labelsData as any)?.labels || (labelsData as any)?.data || [];
  const userMailLabels = mailLabels.filter((l: any) => !l.isSystem);
  const labelColorMap: Record<string, string> = useMemo(
    () => Object.fromEntries(mailLabels.filter((l: any) => l.color?.startsWith('#')).map((l: any) => [l.name, l.color])),
    [mailLabels]
  );

  // Build pagination URL
  const getPageUrl = (page: number) => {
    const basePath = isUnified ? `/weldmail/unified/${folder}` : `/weldmail/${accountId}/${folder}`;
    return page === 1 ? basePath : `${basePath}?page=${page}`;
  };

  // Gmail-style filter state. `draftFilter` is the in-progress form; it is
  // applied to the visible list (`appliedFilter`) only when the user clicks Search.
  const [appliedFilter, setAppliedFilter] = useState<MailFilter>({});
  const [draftFilter, setDraftFilter] = useState<MailFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);

  const activeFilterCount = countActiveFilters(appliedFilter);

  // Use shared pinned/starred contexts
  const pinnedContext = usePinnedMessagesSafe();
  const pinnedEmails = pinnedContext?.pinnedMessages ?? new Set<string>();
  const starredContext = useStarredMessagesSafe();
  const starredEmails = starredContext?.starredMessages ?? new Set<string>();
  const isStarred = (emailId: string) => starredEmails.has(emailId);
  const toggleStar = (emailId: string) => starredContext?.toggleStar(emailId);

  // Map + filter data to ConversationItem[]. Avatar URLs are projected
  // server-side onto each thread/message (resolved from the shared `contacts`
  // table by email match), so we just pass them through.
  const items = useMemo(() => {
    if (displayMode === 'threads') {
      return (threads || [])
        .filter((thread) => threadMatchesFilter(thread, appliedFilter))
        .map((thread) => {
          const item = threadToConversationItem(thread, isUnified, (date) => t.mail.messageList.scheduledPreview.replace('{date}', date));
          const labelColors = Object.fromEntries(
            item.labels.filter((n) => labelColorMap[n]).map((n) => [n, labelColorMap[n]])
          );
          return { ...item, labelColors };
        });
    } else {
      return messages
        .filter((message) => messageMatchesFilter(message, appliedFilter))
        .map((msg) => {
          const item = emailToConversationItem(msg, (date) => t.mail.messageList.scheduledPreview.replace('{date}', date));
          const labelColors = Object.fromEntries(
            item.labels.filter((n) => labelColorMap[n]).map((n) => [n, labelColorMap[n]])
          );
          return { ...item, labelColors };
        });
    }
  }, [displayMode, threads, messages, appliedFilter, labelColorMap]);

  // Thread id -> ThreadSummary lookup for context menu actions
  const threadMap = useMemo(() => {
    const map = new Map<string, ThreadSummary>();
    (threads || []).forEach(t => map.set(t.threadId, t));
    return map;
  }, [threads]);

  // URL generation
  const getItemUrl = (item: ConversationItem) => {
    const folderPath = folder.toLowerCase() === 'inbox' ? 'inbox' : folder.toLowerCase();
    if (isUnified && displayMode === 'threads') {
      const extended = item as ConversationItem & { _latestMessageId?: string; _accountId?: string };
      const msgId = extended._latestMessageId || item.id;
      const acctParam = extended._accountId ? `?accountId=${extended._accountId}` : '';
      return `/weldmail/unified/${folderPath}/${msgId}${acctParam}`;
    }
    if (displayMode === 'threads') {
      const extended = item as ConversationItem & { _latestMessageId?: string };
      return `/weldmail/${accountId}/${folderPath}/${extended._latestMessageId || item.id}`;
    }
    return `/weldmail/${accountId}/${folderPath}/${item.id}`;
  };

  // Selected item matching
  const getSelectedId = () => {
    if (!selectedMessageId) return undefined;
    if (displayMode === 'threads') {
      // Match by latestMessageId
      const thread = (threads || []).find(t => t.latestMessageId === selectedMessageId);
      return thread?.threadId;
    }
    return selectedMessageId;
  };

  // Context menu for threads
  const getThreadContextMenu = (item: ConversationItem) => {
    const thread = threadMap.get(item.id);
    if (!thread) return null;
    const pinned = pinnedEmails.has(thread.threadId);
    const starred = thread.isStarred;
    const hasUnread = thread.unreadCount > 0;
    const threadAccountId = (isUnified && thread.accountId) ? thread.accountId : accountId;
    const basePath = isUnified ? `/weldmail/unified/${folder}` : `/weldmail/${accountId}/${folder}`;
    const threadLabels = thread.labels || [];

    return (
      <>
        {/* Reply / Reply all / Forward */}
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${thread.latestMessageId}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'reply', messageId: thread.latestMessageId } })), 100);
        }}>
          <Reply className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.reply}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${thread.latestMessageId}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'replyAll', messageId: thread.latestMessageId } })), 100);
        }}>
          <ReplyAll className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.replyAll}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${thread.latestMessageId}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'forward', messageId: thread.latestMessageId } })), 100);
        }}>
          <Forward className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.forward}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${thread.latestMessageId}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'forwardAttachment', messageId: thread.latestMessageId } })), 100);
        }}>
          <Paperclip className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.forwardAsAttachment}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Archive / Delete / Mark read / Snooze / Add to Tasks */}
        <ContextMenuItem onClick={() => {
          archiveThread.mutate({ accountId: threadAccountId, threadId: thread.threadId }, {
            onSuccess: (result) => toast.success(t.mail.messageList.archivedMessages.replace('{n}', String(result.archivedCount || 0))),
            onError: () => toast.error(t.mail.messageList.failedToArchive),
          });
        }}>
          <Archive className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.archive}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          trashThread.mutate({ accountId: threadAccountId, threadId: thread.threadId }, {
            onSuccess: (result) => toast.success(t.mail.messageList.movedToTrash.replace('{n}', String(result.trashedCount || 0))),
            onError: () => toast.error(t.mail.messageList.failedToDelete),
          });
        }}>
          <Trash2 className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.delete}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          markThreadAsRead.mutate({ accountId: threadAccountId, threadId: thread.threadId, isRead: hasUnread }, {
            onSuccess: () => toast.success(hasUnread ? t.mail.messageList.markedAsRead : t.mail.messageList.markedAsUnread),
          });
        }}>
          {hasUnread ? <Eye className="h-4 w-4 mr-0.5" /> : <EyeOff className="h-4 w-4 mr-0.5" />}
          {hasUnread ? t.mail.messageList.markAsRead : t.mail.messageList.markAsUnread}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Clock className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.snooze}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem onClick={() => {
              snoozeEmail.mutate({ messageId: thread.latestMessageId, until: addHours(new Date(), 1) }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozed1Hour),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.laterToday1Hour}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              snoozeEmail.mutate({ messageId: thread.latestMessageId, until: addHours(new Date(), 4) }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozed4Hours),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.laterToday4Hours}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const tomorrow = setMinutes(setHours(addDays(new Date(), 1), 8), 0);
              snoozeEmail.mutate({ messageId: thread.latestMessageId, until: tomorrow }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozedUntilTomorrow),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.tomorrowMorning}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const monday = setMinutes(setHours(nextMonday(new Date()), 8), 0);
              snoozeEmail.mutate({ messageId: thread.latestMessageId, until: monday }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozedUntilNextWeek),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.nextWeek}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => {
          createTask.mutate({ title: thread.subject || t.mail.messageList.emailTask, description: `From email: ${thread.latestSenderEmail || thread.latestSender}\n\nPreview: ${thread.preview || ''}`, tags: ['mail'] }, {
            onSuccess: () => toast.success(t.mail.messageList.taskCreated),
            onError: () => toast.error(t.mail.messageList.failedToCreateTask),
          });
        }}>
          <ListChecks className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.addToTasks}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Move to / Label as / Mute */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.moveTo}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem onClick={() => {
              bulkAction.mutate({ accountId: threadAccountId, messageIds: thread.messages.map((m: any) => m.id), action: 'inbox' }, {
                onSuccess: () => toast.success(t.mail.messageList.movedToInbox),
                onError: () => toast.error(t.mail.messageList.failedToMove),
              });
            }}>
              <Inbox className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelInbox}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              markThreadAsSpam.mutate({ accountId: threadAccountId, threadId: thread.threadId, isSpam: true }, {
                onSuccess: () => toast.success(t.mail.messageList.markedAsSpam),
                onError: () => toast.error(t.mail.messageList.failedToMarkAsSpam),
              });
            }}>
              <AlertCircle className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelSpam}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              trashThread.mutate({ accountId: threadAccountId, threadId: thread.threadId }, {
                onSuccess: () => toast.success(t.mail.messageList.movedToTrashSingle),
                onError: () => toast.error(t.mail.messageList.failedToMove),
              });
            }}>
              <Trash2 className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelTrash}
            </ContextMenuItem>
            {/* Custom folder move removed — use labels instead */}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tag className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.labelAs}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48 max-h-64 overflow-y-auto">
            {mailLabels.length > 0 ? mailLabels.map((label: any) => {
              const isApplied = threadLabels.includes(label.name);
              return (
                <ContextMenuItem key={label.id} onClick={() => {
                  updateThreadLabels.mutate({ accountId: threadAccountId, threadId: thread.threadId, labelName: label.name, action: isApplied ? 'remove' : 'add' }, {
                    onSuccess: () => toast.success(isApplied ? t.mail.messageList.labelRemovedToast.replace('{name}', label.name) : t.mail.messageList.labelAddedToast.replace('{name}', label.name)),
                    onError: () => toast.error(t.mail.messageList.failedToUpdateLabel),
                  });
                }}>
                  <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{ backgroundColor: label.color || '#6b7280' }} />
                  <span className="flex-1">{label.name}</span>
                  {isApplied && <span className="text-xs text-muted-foreground ml-1">✓</span>}
                </ContextMenuItem>
              );
            }) : (
              <ContextMenuItem disabled>{t.mail.messageList.noLabels}</ContextMenuItem>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => {
          updateThreadLabels.mutate({ accountId: threadAccountId, threadId: thread.threadId, labelName: 'muted', action: threadLabels.includes('muted') ? 'remove' : 'add' }, {
            onSuccess: () => toast.success(threadLabels.includes('muted') ? t.mail.messageList.conversationUnmuted : t.mail.messageList.conversationMuted),
            onError: () => toast.error(t.mail.messageList.failedToMute),
          });
        }}>
          <BellOff className="h-4 w-4 mr-0.5" />
          {threadLabels.includes('muted') ? t.mail.messageList.unmute : t.mail.messageList.mute}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Star / Pin */}
        <ContextMenuItem onClick={() => {
          toggleStar(thread.latestMessageId);
          toast.success(starred ? t.mail.messageList.starRemoved : t.mail.messageList.conversationStarred);
        }}>
          <Star className={cn('h-4 w-4 mr-0.5', starred && 'text-yellow-500 fill-yellow-500')} />
          {starred ? t.mail.messageList.unstar : t.mail.messageList.star}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          pinnedContext?.togglePin(thread.threadId);
          toast.success(pinned ? t.mail.messageList.conversationUnpinned : t.mail.messageList.conversationPinned);
        }}>
          <Pin className={cn('h-4 w-4 mr-0.5', pinned && 'text-blue-500 fill-blue-500')} />
          {pinned ? t.mail.messageList.unpin : t.mail.messageList.pin}
        </ContextMenuItem>

        {thread.sendStatus === 'scheduled' && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={async () => {
                try {
                  const result = await mailApi.scheduled.cancel(thread.latestMessageId);
                  if (result.success) {
                    toast.success(t.mail.messageList.scheduledEmailCancelled);
                    window.dispatchEvent(new Event('mail:refresh'));
                  } else {
                    toast.error((result as any).error || t.mail.messageList.failedToCancel);
                  }
                } catch {
                  toast.error(t.mail.messageList.failedToCancel);
                }
              }}
              className="text-orange-600 focus:text-orange-600 focus:bg-orange-50 hover:bg-orange-50"
            >
              <X className="h-4 w-4 mr-0.5 text-orange-600" />
              {t.mail.messageList.cancelSchedule}
            </ContextMenuItem>
          </>
        )}

        <ContextMenuSeparator />

        {/* Search / Open in new window */}
        <ContextMenuItem onClick={() => {
          const sender = thread.latestSenderEmail || thread.latestSender;
          setAppliedFilter((prev) => ({ ...prev, from: sender }));
          setDraftFilter((prev) => ({ ...prev, from: sender }));
          toast.success(t.mail.messageList.filteringEmailsFrom.replace('{sender}', sender));
        }}>
          <Search className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.findEmailsFromSender}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          window.open(`${basePath}/${thread.latestMessageId}`, '_blank');
        }}>
          <ExternalLink className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.openInNewWindow}
        </ContextMenuItem>
      </>
    );
  };

  // Context menu for individual messages (non-thread mode)
  const getMessageContextMenu = (item: ConversationItem) => {
    const pinned = pinnedEmails.has(item.id);
    const starred = isStarred(item.id);
    const basePath = isUnified ? `/weldmail/unified/${folder}` : `/weldmail/${accountId}/${folder}`;
    const msgLabels = item.labels || [];
    const hasUnread = !item.isRead;

    return (
      <>
        {/* Reply / Reply all / Forward */}
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${item.id}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'reply', messageId: item.id } })), 100);
        }}>
          <Reply className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.reply}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${item.id}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'replyAll', messageId: item.id } })), 100);
        }}>
          <ReplyAll className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.replyAll}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${item.id}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'forward', messageId: item.id } })), 100);
        }}>
          <Forward className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.forward}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          router.push(`${basePath}/${item.id}`);
          setTimeout(() => window.dispatchEvent(new CustomEvent('mail:action', { detail: { action: 'forwardAttachment', messageId: item.id } })), 100);
        }}>
          <Paperclip className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.forwardAsAttachment}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Archive / Delete / Mark read / Snooze / Add to Tasks */}
        <ContextMenuItem onClick={() => {
          archiveMessage.mutate({ id: item.id, accountId }, {
            onSuccess: () => toast.success(t.mail.messageList.emailArchived),
            onError: () => toast.error(t.mail.messageList.failedToArchive),
          });
        }}>
          <Archive className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.archive}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          trashMessage.mutate({ id: item.id, accountId }, {
            onSuccess: () => toast.success(t.mail.messageList.movedToTrashSingle),
            onError: () => toast.error(t.mail.messageList.failedToDelete),
          });
        }}>
          <Trash2 className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.delete}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          markMailRead.mutate({ id: item.id, read: hasUnread, accountId }, {
            onSuccess: () => toast.success(hasUnread ? t.mail.messageList.markedAsRead : t.mail.messageList.markedAsUnread),
          });
        }}>
          {hasUnread ? <Eye className="h-4 w-4 mr-0.5" /> : <EyeOff className="h-4 w-4 mr-0.5" />}
          {hasUnread ? t.mail.messageList.markAsRead : t.mail.messageList.markAsUnread}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Clock className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.snooze}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem onClick={() => {
              snoozeEmail.mutate({ messageId: item.id, until: addHours(new Date(), 1) }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozed1Hour),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.laterToday1Hour}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              snoozeEmail.mutate({ messageId: item.id, until: addHours(new Date(), 4) }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozed4Hours),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.laterToday4Hours}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const tomorrow = setMinutes(setHours(addDays(new Date(), 1), 8), 0);
              snoozeEmail.mutate({ messageId: item.id, until: tomorrow }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozedUntilTomorrow),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.tomorrowMorning}</ContextMenuItem>
            <ContextMenuItem onClick={() => {
              const monday = setMinutes(setHours(nextMonday(new Date()), 8), 0);
              snoozeEmail.mutate({ messageId: item.id, until: monday }, {
                onSuccess: () => toast.success(t.mail.messageList.snoozedUntilNextWeek),
                onError: () => toast.error(t.mail.messageList.failedToSnooze),
              });
            }}>{t.mail.messageList.nextWeek}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => {
          createTask.mutate({ title: item.subject || t.mail.messageList.emailTask, description: `From: ${item.email || item.name}\n\nPreview: ${item.preview || ''}`, tags: ['mail'] }, {
            onSuccess: () => toast.success(t.mail.messageList.taskCreated),
            onError: () => toast.error(t.mail.messageList.failedToCreateTask),
          });
        }}>
          <ListChecks className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.addToTasks}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Move to / Label as / Mute */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.moveTo}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem onClick={() => {
              bulkAction.mutate({ accountId, messageIds: [item.id], action: 'inbox' }, {
                onSuccess: () => toast.success(t.mail.messageList.movedToInbox),
                onError: () => toast.error(t.mail.messageList.failedToMove),
              });
            }}>
              <Inbox className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelInbox}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              markAsSpam.mutate({ id: item.id, isSpam: true, accountId }, {
                onSuccess: () => toast.success(t.mail.messageList.markedAsSpam),
                onError: () => toast.error(t.mail.messageList.failedToMarkAsSpam),
              });
            }}>
              <AlertCircle className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelSpam}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              trashMessage.mutate({ id: item.id, accountId }, {
                onSuccess: () => toast.success(t.mail.messageList.movedToTrashSingle),
                onError: () => toast.error(t.mail.messageList.failedToMove),
              });
            }}>
              <Trash2 className="h-4 w-4 mr-0.5" /> {t.mail.messageList.labelTrash}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tag className="h-4 w-4 mr-2.5" />
            {t.mail.messageList.labelAs}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48 max-h-64 overflow-y-auto">
            {mailLabels.length > 0 ? mailLabels.map((label: any) => {
              const isApplied = msgLabels.includes(label.name);
              return (
                <ContextMenuItem key={label.id} onClick={() => {
                  const action = isApplied
                    ? mailApi.messages.removeLabel(accountId, item.id, label.name)
                    : mailApi.messages.addLabel(accountId, item.id, label.name);
                  action.then(() => {
                    toast.success(isApplied ? t.mail.messageList.labelRemovedToast.replace('{name}', label.name) : t.mail.messageList.labelAddedToast.replace('{name}', label.name));
                    queryClient.invalidateQueries({ queryKey: ['mail'] });
                  }).catch(() => toast.error(t.mail.messageList.failedToUpdateLabel));
                }}>
                  <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{ backgroundColor: label.color || '#6b7280' }} />
                  <span className="flex-1">{label.name}</span>
                  {isApplied && <span className="text-xs text-muted-foreground ml-1">✓</span>}
                </ContextMenuItem>
              );
            }) : (
              <ContextMenuItem disabled>{t.mail.messageList.noLabels}</ContextMenuItem>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => {
          const isMuted = msgLabels.includes('muted');
          const action = isMuted
            ? mailApi.messages.removeLabel(accountId, item.id, 'muted')
            : mailApi.messages.addLabel(accountId, item.id, 'muted');
          action.then(() => {
            toast.success(isMuted ? t.mail.messageList.emailUnmuted : t.mail.messageList.emailMuted);
            queryClient.invalidateQueries({ queryKey: ['mail'] });
          }).catch(() => toast.error(t.mail.messageList.failedToMute));
        }}>
          <BellOff className="h-4 w-4 mr-0.5" />
          {msgLabels.includes('muted') ? t.mail.messageList.unmute : t.mail.messageList.mute}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Star / Pin */}
        <ContextMenuItem onClick={() => {
          toggleStar(item.id);
          toast.success(starred ? t.mail.messageList.starRemoved : t.mail.messageList.emailStarred);
        }}>
          <Star className={cn('h-4 w-4 mr-0.5', starred && 'text-yellow-500 fill-yellow-500')} />
          {starred ? t.mail.messageList.unstar : t.mail.messageList.star}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          pinnedContext?.togglePin(item.id);
          toast.success(pinned ? t.mail.messageList.emailUnpinned : t.mail.messageList.emailPinned);
        }}>
          <Pin className={cn('h-4 w-4 mr-0.5', pinned && 'text-blue-500 fill-blue-500')} />
          {pinned ? t.mail.messageList.unpin : t.mail.messageList.pin}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Search / Open in new window */}
        <ContextMenuItem onClick={() => {
          const sender = item.email || item.name;
          setAppliedFilter((prev) => ({ ...prev, from: sender }));
          setDraftFilter((prev) => ({ ...prev, from: sender }));
          toast.success(t.mail.messageList.filteringEmailsFrom.replace('{sender}', sender));
        }}>
          <Search className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.findEmailsFromSender}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          window.open(`${basePath}/${item.id}`, '_blank');
        }}>
          <ExternalLink className="h-4 w-4 mr-0.5" />
          {t.mail.messageList.openInNewWindow}
        </ContextMenuItem>
      </>
    );
  };

  // Mail filter popover content
  const updateDraft = (patch: Partial<MailFilter>) => setDraftFilter((prev) => ({ ...prev, ...patch }));
  const applyFilter = () => {
    setAppliedFilter(draftFilter);
    setFilterOpen(false);
  };
  const clearFilter = () => {
    setDraftFilter({});
    setAppliedFilter({});
  };

  const filterRowClass = 'grid grid-cols-[96px_1fr] items-center gap-3';
  const filterLabelClass = 'text-sm text-muted-foreground';
  const draftActiveCount = countActiveFilters(draftFilter);

  const filterPopover = (
    <Popover
      open={filterOpen}
      onOpenChange={(open) => {
        // Sync the form to whatever is currently applied each time it opens.
        if (open) setDraftFilter(appliedFilter);
        setFilterOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-8 text-sm px-3 shadow-none gap-1.5',
            activeFilterCount > 0 ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {t.mail.messageList.filter}
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
              {activeFilterCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[460px] p-4">
        <div
          className="space-y-3"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyFilter();
            }
          }}
        >
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterFromLabel}</span>
            <Input value={draftFilter.from ?? ''} onChange={(e) => updateDraft({ from: e.target.value })} className="h-8 text-sm" />
          </div>
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterToLabel}</span>
            <Input value={draftFilter.to ?? ''} onChange={(e) => updateDraft({ to: e.target.value })} className="h-8 text-sm" />
          </div>
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterSubjectLabel}</span>
            <Input value={draftFilter.subject ?? ''} onChange={(e) => updateDraft({ subject: e.target.value })} className="h-8 text-sm" />
          </div>
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterHasWords}</span>
            <Input value={draftFilter.hasWords ?? ''} onChange={(e) => updateDraft({ hasWords: e.target.value })} className="h-8 text-sm" />
          </div>
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterDoesntHave}</span>
            <Input value={draftFilter.doesntHave ?? ''} onChange={(e) => updateDraft({ doesntHave: e.target.value })} className="h-8 text-sm" />
          </div>

          {/* Size */}
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterSize}</span>
            <div className="flex items-center gap-2">
              <Select value={draftFilter.sizeOp ?? 'gt'} onValueChange={(v) => updateDraft({ sizeOp: v as MailFilterSizeOp })}>
                <SelectTrigger className="h-8 text-sm flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="gt">{t.mail.messageList.filterSizeGreater}</SelectItem>
                  <SelectItem value="lt">{t.mail.messageList.filterSizeLess}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={0}
                value={draftFilter.sizeValue ?? ''}
                onChange={(e) => updateDraft({ sizeValue: e.target.value })}
                className="h-8 text-sm w-20"
              />
              <Select value={draftFilter.sizeUnit ?? 'mb'} onValueChange={(v) => updateDraft({ sizeUnit: v as MailFilterSizeUnit })}>
                <SelectTrigger className="h-8 text-sm w-[88px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mb">{t.mail.messageList.filterSizeMB}</SelectItem>
                  <SelectItem value="kb">{t.mail.messageList.filterSizeKB}</SelectItem>
                  <SelectItem value="bytes">{t.mail.messageList.filterSizeBytes}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Date within */}
          <div className={filterRowClass}>
            <span className={filterLabelClass}>{t.mail.messageList.filterDateWithin}</span>
            <div className="flex items-center gap-2">
              <Select value={draftFilter.dateWithin ?? '1d'} onValueChange={(v) => updateDraft({ dateWithin: v as MailFilterDateWithin })}>
                <SelectTrigger className="h-8 text-sm flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">{t.mail.messageList.filterWithin1Day}</SelectItem>
                  <SelectItem value="3d">{t.mail.messageList.filterWithin3Days}</SelectItem>
                  <SelectItem value="1w">{t.mail.messageList.filterWithin1Week}</SelectItem>
                  <SelectItem value="2w">{t.mail.messageList.filterWithin2Weeks}</SelectItem>
                  <SelectItem value="1m">{t.mail.messageList.filterWithin1Month}</SelectItem>
                  <SelectItem value="2m">{t.mail.messageList.filterWithin2Months}</SelectItem>
                  <SelectItem value="6m">{t.mail.messageList.filterWithin6Months}</SelectItem>
                  <SelectItem value="1y">{t.mail.messageList.filterWithin1Year}</SelectItem>
                </SelectContent>
              </Select>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-8 flex-1 justify-start text-sm gap-2 font-normal',
                      draftFilter.dateWithinDate ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
                    {draftFilter.dateWithinDate ? format(draftFilter.dateWithinDate, 'PP') : t.mail.messageList.filterDatePlaceholder}
                    {draftFilter.dateWithinDate && (
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateDraft({ dateWithinDate: undefined });
                        }}
                        className="ml-auto p-0.5 rounded-sm hover:bg-accent"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={draftFilter.dateWithinDate}
                    onSelect={(date) => updateDraft({ dateWithinDate: date || undefined })}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Has attachment */}
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id="mail-filter-has-attachment"
              checked={!!draftFilter.hasAttachment}
              onCheckedChange={(checked) => updateDraft({ hasAttachment: checked === true })}
            />
            <label htmlFor="mail-filter-has-attachment" className="text-sm cursor-pointer select-none">
              {t.mail.messageList.filterHasAttachment}
            </label>
          </div>
        </div>

        <Separator className="my-5" />

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-sm text-muted-foreground"
            disabled={draftActiveCount === 0 && activeFilterCount === 0}
            onClick={clearFilter}
          >
            {t.mail.messageList.clearAllFilters}
          </Button>
          <Button size="sm" className="h-8 text-sm" onClick={applyFilter}>
            {t.mail.messageList.filterSearch}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );

  // Handle label drag-and-drop from sidebar onto email rows
  const handleLabelDrop = (item: ConversationItem, labelData: { name: string; accountIds?: string[] }) => {
    if (displayMode === 'threads') {
      const thread = threadMap.get(item.id);
      if (!thread) return;
      const threadAccountId = (isUnified && thread.accountId) ? thread.accountId : accountId;

      // In unified mode, prevent cross-account labeling
      if (isUnified && labelData.accountIds && labelData.accountIds.length > 0) {
        if (!labelData.accountIds.includes(threadAccountId)) {
          toast.error(t.mail.messageList.labelNotOnAccount);
          return;
        }
      }

      // Skip if label already applied
      if (thread.labels?.includes(labelData.name)) {
        toast.info(t.mail.messageList.labelAlreadyApplied.replace('{name}', labelData.name));
        return;
      }

      onThreadLabelUpdate?.(thread.threadId, labelData.name, 'add');
      updateThreadLabels.mutate(
        { accountId: threadAccountId, threadId: thread.threadId, labelName: labelData.name, action: 'add' },
        {
          onSuccess: () => toast.success(t.mail.messageList.labelAddedToast.replace('{name}', labelData.name)),
          onError: () => {
            onThreadLabelUpdate?.(thread.threadId, labelData.name, 'remove');
            toast.error(t.mail.messageList.failedToAddLabel);
          },
        }
      );
    } else {
      // Individual message mode — not unified, so accountId is always the current one
      if (item.labels?.includes(labelData.name)) {
        toast.info(t.mail.messageList.labelAlreadyApplied.replace('{name}', labelData.name));
        return;
      }

      mailApi.messages
        .addLabel(accountId, item.id, labelData.name)
        .then(() => {
          toast.success(t.mail.messageList.labelAddedToast.replace('{name}', labelData.name));
          queryClient.invalidateQueries({ queryKey: ['mail'] });
        })
        .catch(() => toast.error(t.mail.messageList.failedToAddLabel));
    }
  };

  return (
    <ConversationList
      items={items}
      selectedId={getSelectedId()}
      getItemUrl={getItemUrl}
      filterContent={filterPopover}
      actionLabel={t.mail.messageList.compose}
      onAction={() => {
        // Pass the current URL as returnUrl so the compose X button takes the
        // user back to the email they had open (instead of the empty
        // "Select a message" state).
        const base = isUnified
          ? `/weldmail/unified/${folder}/compose`
          : `/weldmail/${accountId}/${folder}/compose`;
        const ret = encodeURIComponent(window.location.pathname);
        router.push(`${base}?returnUrl=${ret}`);
      }}
      isPinned={(id) => pinnedEmails.has(id)}
      onTogglePin={(id) => pinnedContext?.togglePin(id)}
      onToggleStar={(id) => {
        if (displayMode === 'threads') {
          const thread = threadMap.get(id);
          if (thread) toggleStar(thread.latestMessageId);
        } else {
          toggleStar(id);
        }
      }}
      contextMenuItems={displayMode === 'threads' ? getThreadContextMenu : getMessageContextMenu}
      onLabelDrop={handleLabelDrop}
      error={error}
      currentPage={currentPage}
      totalPages={totalPages}
      totalCount={totalCount}
      pageSize={pageSize}
      getPageUrl={getPageUrl}
      emptyMessage={displayMode === 'threads' ? t.mail.messageList.noConversationsFound : t.mail.messageList.noMessagesFound}
    />
  );
}
