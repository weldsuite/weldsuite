
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter } from '@/lib/router';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import {
  Reply,
  Forward,
  Star,
  Trash,
  Trash2,
  Archive,
  MoreVertical,
  ChevronDown,
  Tag,
  Loader2,
  AlertTriangle,
  Send,
  Paperclip,
  Eye,
  Copy,
  ExternalLink,
  FileDown,
  ListFilter,
  Flag,
  Inbox,
  Link,
  X,
  Check,
  Clock,
  Pin,
  ChevronLeft,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  PictureInPicture2,
  Maximize,
  FileText,
  PenLine,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { usePinnedMessagesSafe } from '@/contexts/pinned-messages-context';
import { useStarredMessagesSafe } from '@/contexts/starred-messages-context';
import { useCustomerPanel } from '@/contexts/customer-panel-context';
import { useComposeSafe } from '@/contexts/compose-context';
import { mailApi } from '../lib/api-client';
import { IsolatedHtmlContent } from './isolated-html-content';
import {
  useArchiveThread,
  useTrashThread,
  useMarkThreadAsSpam,
  useDeleteMailDraft,
  useGenerateAutoDraft,
  useGenerateAIReply,
  useMailAttachments,
} from '@/hooks/queries/use-mail-queries';
import type { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';
import { CustomerDetailPanel } from './customer-detail-panel';
import { CalendarInviteCard } from './calendar-invite-card';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';

type EmailMessage = MailTypes.Email;

function getAvatarColor(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Extract email from "Name <email>" format or return the string if it's just an email
function extractEmail(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  if (match) return match[1];
  // Check if the string itself is an email
  if (sender.includes('@')) return sender;
  return '';
}

// Extract name from "Name <email>" format
function extractName(sender: string): string {
  const match = sender.match(/^([^<]+)</);
  if (match) return match[1].trim();
  // If no angle brackets, check if it's just an email
  if (sender.includes('@')) {
    return sender.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return sender;
}

// Generate consistent label color based on label name
function getLabelColor(labelName: string, labelData?: MailTypes.Label): string {
  // Use stored color if available
  if (labelData?.color?.startsWith('#')) {
    return labelData.color;
  }
  // Generate consistent color from name
  const colors = [
    '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
    '#3B82F6', '#8B5CF6', '#EC4899',
  ];
  let hash = 0;
  for (let i = 0; i < labelName.length; i++) {
    hash = labelName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function parseMainContent(bodyHtml?: string, bodyText?: string): { main: string; quoted: string } {
  const content = bodyHtml || bodyText || '';
  if (!content) return { main: '', quoted: '' };

  // Gmail quote detection
  const gmailQuoteIndex = content.search(/<div[^>]*class="[^"]*gmail_quote[^"]*"/i);
  if (gmailQuoteIndex !== -1) {
    return {
      main: content.substring(0, gmailQuoteIndex).trim(),
      quoted: content.substring(gmailQuoteIndex).trim(),
    };
  }

  // Outlook-style: <hr> followed by From: header (any content between, generous limit)
  const outlookHrQuote = content.search(/<hr[^>]*>[\s\S]{0,500}?\bFrom\s*:/i);
  if (outlookHrQuote !== -1) {
    return {
      main: content.substring(0, outlookHrQuote).trim(),
      quoted: content.substring(outlookHrQuote).trim(),
    };
  }

  // Outlook blockquote style
  const outlookBlockquote = content.search(/<blockquote[^>]*>[\s\S]{0,200}?\bFrom\s*:/i);
  if (outlookBlockquote !== -1) {
    return {
      main: content.substring(0, outlookBlockquote).trim(),
      quoted: content.substring(outlookBlockquote).trim(),
    };
  }

  // Generic: "From:" + "Sent:" + "To:" + "Subject:" pattern in any HTML
  const genericQuoteHeaders = content.search(/(<[^>]*>[\s\n]*)*(<b>|<strong>)?\s*From\s*:\s*(<\/b>|<\/strong>)?[\s\S]{0,300}?\bSent\s*:[\s\S]{0,300}?\bTo\s*:[\s\S]{0,300}?\bSubject\s*:/i);
  if (genericQuoteHeaders !== -1) {
    return {
      main: content.substring(0, genericQuoteHeaders).trim(),
      quoted: content.substring(genericQuoteHeaders).trim(),
    };
  }

  // Plain text fallback: line starting with "From:" followed by "Sent:"
  if (!bodyHtml && bodyText) {
    const textQuote = content.search(/^From\s*:.*\nSent\s*:/im);
    if (textQuote !== -1) {
      return {
        main: content.substring(0, textQuote).trim(),
        quoted: content.substring(textQuote).trim(),
      };
    }
  }

  return { main: content, quoted: '' };
}

function ThreadMessageContent({ threadMsg }: { threadMsg: EmailMessage }) {
  const { t } = useI18n();
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = parseMainContent(threadMsg.bodyHtml, threadMsg.bodyText);
  const isHtml = !!threadMsg.bodyHtml;

  return (
    <div className="px-3 md:px-4 pb-4 pt-0 overflow-x-auto group/email">
      <div className="text-sm text-foreground leading-relaxed">
        {main ? (
          isHtml ? (
            <IsolatedHtmlContent html={main} />
          ) : (
            <div className="whitespace-pre-wrap">{main}</div>
          )
        ) : threadMsg.bodyText ? (
          <div className="whitespace-pre-wrap">{threadMsg.bodyText}</div>
        ) : (
          <div className="text-gray-400 italic">{t.mail.messageDetail.noContent}</div>
        )}
        {quoted && (
          <>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setShowQuoted(!showQuoted)}
              className={cn("mt-2 inline-flex items-center justify-center h-5 w-8 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md hover:bg-muted-foreground/20 transition-all", !showQuoted && "opacity-0 group-hover/email:opacity-100")}
              title={showQuoted ? t.mail.messageDetail.hideQuotedText : t.mail.messageDetail.showQuotedText}
            >
              ···
            </Button>
            {showQuoted && (
              <div className="mt-2">
                {isHtml ? (
                  <IsolatedHtmlContent html={quoted} />
                ) : (
                  <div className="whitespace-pre-wrap">{quoted}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ScheduledBanner({ messageId, scheduledFor, accountId, folder }: {
  messageId: string;
  scheduledFor: string | Date;
  accountId: string;
  folder: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [newDate, setNewDate] = useState<Date | undefined>(new Date(scheduledFor));
  const [newTime, setNewTime] = useState(() => format(new Date(scheduledFor), 'HH:mm'));

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      const result = await mailApi.scheduled.cancel(messageId);
      if (result.success) {
        toast.success(t.mail.messageDetail.scheduledEmailCancelled);
        window.dispatchEvent(new Event('mail:refresh'));
        router.push(`/weldmail/${accountId}/${folder}`);
      } else {
        toast.error(result.error || t.mail.messageDetail.cancelScheduledFailed);
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToCancelScheduled);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleReschedule = async () => {
    if (!newDate) return;
    setIsRescheduling(true);
    try {
      const scheduled = new Date(newDate);
      const [hours, minutes] = newTime.split(':').map(Number);
      scheduled.setHours(hours, minutes, 0, 0);

      if (scheduled <= new Date()) {
        toast.error(t.mail.messageDetail.scheduledTimeMustBeFuture);
        setIsRescheduling(false);
        return;
      }

      const result = await mailApi.scheduled.reschedule(messageId, scheduled);
      if (result.success) {
        toast.success(t.mail.messageDetail.rescheduled.replace('{date}', format(scheduled, 'PPp')));
        window.dispatchEvent(new Event('mail:refresh'));
        setShowReschedule(false);
      } else {
        toast.error(result.error || t.mail.messageDetail.failedToReschedule);
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToReschedule);
    } finally {
      setIsRescheduling(false);
    }
  };

  const scheduledDate = new Date(scheduledFor);
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 7);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-blue-50 border-b border-blue-100 flex-shrink-0">
      <div className="flex items-center gap-2 text-sm text-blue-700">
        <Clock className="h-4 w-4" />
        <span className="font-medium">
          {t.mail.messageDetail.scheduledFor.replace('{date}', format(scheduledDate, 'PPp'))}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Popover open={showReschedule} onOpenChange={setShowReschedule}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">
              <PenLine className="h-3 w-3 mr-1" />
              {t.mail.messageDetail.reschedule}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="end">
            <div className="space-y-3">
              <Calendar
                mode="single"
                selected={newDate}
                onSelect={setNewDate}
                disabled={(date) =>
                  date < new Date(new Date().setHours(0, 0, 0, 0)) || date > maxDate
                }
              />
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="flex-1 h-8 px-2 text-sm border border-border rounded-md bg-background"
                />
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleReschedule}
                  disabled={isRescheduling || !newDate}
                >
                  {isRescheduling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t.mail.messageDetail.save
                  )}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
          onClick={handleCancel}
          disabled={isCancelling}
        >
          {isCancelling ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <X className="h-3 w-3 mr-1" />
          )}
          {t.mail.messageDetail.cancel}
        </Button>
      </div>
    </div>
  );
}

interface ThreadDraft {
  id: string;
  to: string[];
  subject: string;
  body: string;
  htmlBody: string;
  inReplyTo: string;
  updatedAt: string;
}

interface MessageDetailProps {
  message: EmailMessage;
  thread?: EmailMessage[];
  accountId: string;
  folder: string;
  availableLabels?: MailTypes.Label[];
  onLabelsChange?: (labels: string[]) => void;
  threadId?: string | null;
  drafts?: ThreadDraft[];
}

export function MessageDetail({ message, thread = [], accountId, folder, availableLabels = [], onLabelsChange, threadId, drafts = [] }: MessageDetailProps) {
  const { t } = useI18n();
  const router = useRouter();
  const archiveThreadMutation = useArchiveThread();
  const trashThreadMutation = useTrashThread();
  const markThreadAsSpamMutation = useMarkThreadAsSpam();
  const deleteDraftMutation = useDeleteMailDraft();
  const generateAutoDraftMutation = useGenerateAutoDraft();
  const generateAIReplyMutation = useGenerateAIReply();
  const handleAiCreditsError = useAiCreditsToast();
  const [isReplying, setIsReplying] = useState(false);
  const [isForwarding, setIsForwarding] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [composeData, setComposeData] = useState({ to: '', subject: '', body: '' });
  const editorRef = useRef<HTMLDivElement>(null);
  const [activeFormats, setActiveFormats] = useState<Record<string, boolean>>({});
  const [messageLabels, setMessageLabels] = useState<string[]>(message.labels || []);
  const [isUpdatingLabels, setIsUpdatingLabels] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [localThread, setLocalThread] = useState<EmailMessage[]>(thread);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => new Set(thread.map(t => t.id)));
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  const [userLabels, setUserLabels] = useState<{ id: string; name: string; color?: string | null }[]>([]);
  const [showAddTaskDialog, setShowAddTaskDialog] = useState(false);

  // AI state
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [isAutoDraft, setIsAutoDraft] = useState(false);
  const [isAgentInline, setIsAgentInline] = useState(false);
  const [, setShowInlineAiInput] = useState(false);
  const [inlineAiPrompt, setInlineAiPrompt] = useState('');
  const [isInlineAiGenerating, setIsInlineAiGenerating] = useState(false);
  const inlineAiInputRef = useRef<HTMLTextAreaElement>(null);

  // Customer panel context
  const customerPanel = useCustomerPanel();

  // Compose context for floating panel
  const composeContext = useComposeSafe();

  // Navigate back to the message list (for mobile)
  const handleBackToList = () => {
    router.push(`/weldmail/${accountId}/${folder}`);
  };

  // Track active formatting in the editor
  useEffect(() => {
    const updateFormats = () => {
      setActiveFormats({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
      });
    };
    document.addEventListener('selectionchange', updateFormats);
    return () => document.removeEventListener('selectionchange', updateFormats);
  }, []);

  // Sync local thread with prop
  useEffect(() => {
    setLocalThread(thread);
    setExpandedThreadIds(new Set(thread.map(t => t.id)));
  }, [thread]);

  // Fetch user labels on mount
  useEffect(() => {
    const fetchLabels = async () => {
      try {
        const result = await mailApi.labels.list(accountId);
        if (result.success && result.data) {
          // The legacy `Mail.Label` client type predates `isSystem`; the
          // `/mail-labels` route actually returns it (see `MailLabelRow`).
          const labels = result.data as Array<MailTypes.Label & { isSystem?: boolean | null }>;
          setUserLabels(
            labels
              .filter((l) => !l.isSystem)
              .map((l) => ({ id: l.id ?? '', name: l.name, color: l.color }))
          );
        }
      } catch {
        // Silently fail - labels just won't be available
      }
    };
    fetchLabels();
  }, [accountId]);

  // Use shared pinned messages context
  const pinnedContext = usePinnedMessagesSafe();
  const isPinned = pinnedContext?.isPinned(message.id) ?? false;

  // Use shared starred messages context
  const starredContext = useStarredMessagesSafe();
  const isStarred = starredContext?.isStarred(message.id) ?? message.isStarred;

  const handleTogglePin = () => {
    if (pinnedContext) {
      pinnedContext.togglePin(message.id);
      toast.success(isPinned ? t.mail.messageDetail.emailUnpinned : t.mail.messageDetail.emailPinned);
    }
  };

  // Compute the newest message (shown at top) and older messages (shown in thread)
  const { newestMessage, olderMessages } = useMemo(() => {
    const allMessages = [message, ...localThread];
    allMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return {
      newestMessage: allMessages[0],
      olderMessages: allMessages.slice(1),
    };
  }, [message, localThread]);

  // The api-worker mail list / thread routes resolve sender avatars from the
  // shared `contacts` table and project them onto `from.avatarUrl` for every
  // message, so we just read them off the message object — no extra fetch.
  const getSenderAvatarUrl = (m: { from?: unknown }): string | undefined => {
    if (typeof m.from === 'object' && m.from !== null) {
      const url = (m.from as { avatarUrl?: string | null }).avatarUrl;
      return url ?? undefined;
    }
    return undefined;
  };

  // Fetch attachments for the newest message
  const { data: attachmentsData } = useMailAttachments(
    newestMessage?.id || '',
    !!newestMessage?.hasAttachments,
  );
  const attachments = attachmentsData?.data || [];

  // Calendar invites (.ics) get a dedicated "Add to Weld Calendar" card; the
  // remaining attachments render as the usual download chips.
  const isIcsAttachment = (att: { contentType?: string | null; fileName?: string | null }) =>
    (att.contentType || '').toLowerCase().includes('text/calendar') ||
    (att.fileName || '').toLowerCase().endsWith('.ics');
  // A single invite frequently arrives as two MIME parts — an inline
  // `text/calendar` body part AND a named `invite.ics` attachment (Gmail and
  // Outlook both do this) — which would otherwise render two identical cards.
  // The two parts carry byte-identical payloads, so collapse by content size;
  // genuinely different invites differ in size.
  const calendarInvites = (() => {
    const ics = attachments.filter((att) => isIcsAttachment(att) && att.downloadUrl);
    const seenSizes = new Set<number>();
    return ics.filter((att) => {
      const size = att.size;
      if (typeof size !== 'number') return true;
      if (seenSizes.has(size)) return false;
      seenSizes.add(size);
      return true;
    });
  })();
  const otherAttachments = attachments.filter((att) => !isIcsAttachment(att));

  // Listen for context-menu reply/forward actions
  useEffect(() => {
    const handleMailAction = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.messageId && detail.messageId !== message.id && detail.messageId !== newestMessage.id) return;
      const action = detail?.action;
      if (action === 'reply' || action === 'replyAll') {
        setIsReplying(true);
        setIsForwarding(false);
        setReplyToMessageId(newestMessage.id);
        const allRecipients = action === 'replyAll';
        const to = allRecipients
          ? [newestMessage.fromEmail || newestMessage.from || '', ...(newestMessage.cc || [])].filter(Boolean).join(', ')
          : newestMessage.fromEmail || newestMessage.from || '';
        setComposeData({ to, subject: `Re: ${message.subject}`, body: '' });
      } else if (action === 'forward' || action === 'forwardAttachment') {
        setIsForwarding(true);
        setIsReplying(false);
        setReplyToMessageId(newestMessage.id);
        setComposeData({ to: '', subject: `Fwd: ${message.subject}`, body: '' });
      }
    };
    window.addEventListener('mail:action', handleMailAction);
    return () => window.removeEventListener('mail:action', handleMailAction);
  }, [message.id, message.subject, newestMessage]);

  const { main: mainContent, quoted: quotedContent } = parseMainContent(newestMessage.bodyHtml, newestMessage.bodyText);
  const isHtml = !!newestMessage.bodyHtml;
  const [showQuoted, setShowQuoted] = useState(false);
  // Gmail-style: Check labels array instead of folder
  const isInTrashFolder = messageLabels.includes('trash') || folder?.toLowerCase() === 'trash';
  const isInSpamFolder = messageLabels.includes('spam') || folder?.toLowerCase() === 'spam';

  const toggleThreadExpanded = (id: string) => {
    setExpandedThreadIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  const addOptimisticMessage = (body: string, to: string, html?: string) => {
    const optimisticMsg: EmailMessage = {
      id: `optimistic-${Date.now()}`,
      messageId: '',
      subject: message.subject,
      from: newestMessage.to?.[0] || 'Me',
      fromEmail: newestMessage.to?.[0] || '',
      to: [to],
      cc: [],
      bcc: [],
      bodyText: body,
      // Prefer the exact HTML that was sent to the server so the optimistic
      // render matches the reloaded (server) version. Falling back to a naive
      // newline->`<br>` conversion loses whitespace/line breaks, which is why
      // sent replies briefly appeared with their spacing collapsed until reload.
      bodyHtml: html || body.replace(/\n/g, '<br>'),
      preview: body.substring(0, 100),
      date: new Date(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      isDraft: false,
      isSpam: false,
      isDeleted: false,
      hasAttachments: false,
      size: body.length,
      labels: ['sent'],
      folder: 'Sent',
    };
    setLocalThread(prev => [...prev, optimisticMsg]);
    // The current newestMessage will move to olderMessages, expand it
    setExpandedThreadIds(prev => new Set([...prev, newestMessage.id]));
  };

  const handleSendReply = async () => {
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    if (!textContent.trim()) {
      toast.error(t.mail.composePage.enterMessage);
      return;
    }
    setIsSending(true);
    try {
      const toAddresses = composeData.to.split(/[,;]/).map((e: string) => e.trim()).filter((e: string) => e.length > 0);
      const result = await mailApi.messages.reply(accountId, message.id, {
        body: textContent,
        htmlBody: htmlContent,
        replyAll: toAddresses.length > 1,
      });
      if (result.success) {
        toast.success(t.mail.messageDetail.replySent);
        addOptimisticMessage(textContent, composeData.to, htmlContent);
        setIsReplying(false);
        setReplyToMessageId(null);
        setComposeData({ to: '', subject: '', body: '' });
        if (editorRef.current) editorRef.current.innerHTML = '';
      } else {
        toast.error(result.error || t.mail.messageDetail.failedToSendReply);
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToSendReply);
    } finally {
      setIsSending(false);
    }
  };

  const handleSendForward = async () => {
    const toAddresses = composeData.to.split(/[,;]/).map((e: string) => e.trim()).filter((e: string) => e.length > 0);
    if (toAddresses.length === 0) {
      toast.error(t.mail.composePage.atLeastOneRecipient);
      return;
    }
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    setIsSending(true);
    try {
      const result = await mailApi.messages.forward(accountId, message.id, {
        to: toAddresses,
        body: textContent || undefined,
        htmlBody: htmlContent || undefined,
      });
      if (result.success) {
        toast.success(t.mail.messageDetail.emailForwarded);
        addOptimisticMessage(textContent || `Forwarded: ${message.subject}`, composeData.to, htmlContent || undefined);
        setIsForwarding(false);
        setReplyToMessageId(null);
        setComposeData({ to: '', subject: '', body: '' });
        if (editorRef.current) editorRef.current.innerHTML = '';
      } else {
        toast.error(result.error || t.mail.messageDetail.failedToForwardEmail);
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToForwardEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleToggleStar = async () => {
    if (starredContext) {
      starredContext.toggleStar(message.id);
      toast.success(isStarred ? t.mail.messageDetail.starRemoved : t.mail.messageDetail.starAdded);
    }
    // Also call the API for persistence
    await mailApi.messages.update(accountId, message.id, { isStarred: !isStarred });
  };

  const handleDelete = async () => {
    if (isInTrashFolder) {
      // Permanently delete
      const result = await mailApi.messages.delete(accountId, message.id);
      if (result.success) {
        toast.success(t.mail.messageDetail.deletedPermanently);
        // Refresh the list and leave the (now-gone) message view.
        window.dispatchEvent(new Event('mail:refresh'));
        handleBackToList();
      } else {
        toast.error(t.mail.messageDetail.failedToMoveToTrash);
      }
    } else if (threadId) {
      // Thread-level: Trash all messages in the conversation
      trashThreadMutation.mutate({ accountId, threadId }, {
        onSuccess: (result) => {
          toast.success(t.mail.messageDetail.movedToTrash.replace('{n}', String(result.trashedCount ?? 1)));
          // Refresh the list and leave the trashed conversation.
          window.dispatchEvent(new Event('mail:refresh'));
          handleBackToList();
        },
        onError: () => {
          toast.error(t.mail.messageDetail.failedToMoveToTrash);
        },
      });
      return;
    } else {
      // Gmail-style: Add "trash" label, remove "inbox" label
      try {
        // Add trash label
        await mailApi.messages.addLabel(accountId, message.id, 'trash');
        // Remove inbox label if present
        if (messageLabels.includes('inbox')) {
          await mailApi.messages.removeLabel(accountId, message.id, 'inbox');
        }
        const newLabels = messageLabels.filter(l => l !== 'inbox').concat('trash');
        setMessageLabels(newLabels);
        onLabelsChange?.(newLabels);
        toast.success(t.mail.messageDetail.movedSingleToTrash);
        // Refresh the list and leave the trashed message.
        window.dispatchEvent(new Event('mail:refresh'));
        handleBackToList();
      } catch {
        toast.error(t.mail.messageDetail.failedToMoveSingleToTrash);
      }
    }
  };

  const handleArchive = async () => {
    if (threadId) {
      // Thread-level: Archive all messages in the conversation
      archiveThreadMutation.mutate({ accountId, threadId }, {
        onSuccess: (result) => {
          toast.success(t.mail.messageDetail.archivedMessages.replace('{n}', String(result.archivedCount ?? 1)));
        },
        onError: () => {
          toast.error(t.mail.messageDetail.failedToArchive);
        },
      });
      return;
    } else {
      // Gmail-style: Remove "inbox" label, add "archive" label
      try {
        // Remove inbox label
        if (messageLabels.includes('inbox')) {
          await mailApi.messages.removeLabel(accountId, message.id, 'inbox');
        }
        // Add archive label
        await mailApi.messages.addLabel(accountId, message.id, 'archive');
        const newLabels = messageLabels.filter(l => l !== 'inbox').concat('archive');
        setMessageLabels(newLabels);
        onLabelsChange?.(newLabels);
        toast.success(t.mail.messageDetail.archivedSingle);
      } catch {
        toast.error(t.mail.messageDetail.failedToArchiveSingle);
      }
    }
  };

  const handleMarkAsSpam = async () => {
    const isCurrentlySpam = messageLabels.includes('spam');

    if (threadId) {
      // Thread-level: Mark all messages as spam/not spam
      markThreadAsSpamMutation.mutate({ accountId, threadId, isSpam: !isCurrentlySpam }, {
        onSuccess: () => {
          toast.success(isCurrentlySpam ? t.mail.messageDetail.markedConversationAsNotSpam : t.mail.messageDetail.markedConversationAsSpam);
        },
        onError: () => {
          toast.error(t.mail.messageDetail.failedToUpdateSpamStatus);
        },
      });
      return;
    } else {
      try {
        if (isCurrentlySpam) {
          // Gmail-style: Remove "spam" label, add "inbox" label
          await mailApi.messages.removeLabel(accountId, message.id, 'spam');
          await mailApi.messages.addLabel(accountId, message.id, 'inbox');
          const newLabels = messageLabels.filter(l => l !== 'spam').concat('inbox');
          setMessageLabels(newLabels);
          onLabelsChange?.(newLabels);
          toast.success(t.mail.messageDetail.markedAsNotSpam);
        } else {
          // Gmail-style: Add "spam" label, remove "inbox" label
          await mailApi.messages.addLabel(accountId, message.id, 'spam');
          if (messageLabels.includes('inbox')) {
            await mailApi.messages.removeLabel(accountId, message.id, 'inbox');
          }
          const newLabels = messageLabels.filter(l => l !== 'inbox').concat('spam');
          setMessageLabels(newLabels);
          onLabelsChange?.(newLabels);
          toast.success(t.mail.messageDetail.markedAsSpam);
        }
      } catch {
        toast.error(t.mail.messageDetail.failedToUpdateSpamStatus);
      }
    }
  };

  const handleMarkAsRead = async (isRead: boolean) => {
    const result = await mailApi.messages.update(accountId, message.id, { isRead });
    if (result.success) toast.success(isRead ? t.mail.messageDetail.markedAsRead : t.mail.messageDetail.markedAsUnread);
  };

  const handleSetImportance = async () => {
    const result = await mailApi.messages.update(accountId, message.id, { isImportant: true });
    if (result.success) toast.success(t.mail.messageDetail.markedAsImportant);
  };

  const handleToggleLabel = async (labelName: string) => {
    setIsUpdatingLabels(true);
    const hasLabel = messageLabels.includes(labelName);

    try {
      if (hasLabel) {
        // Remove label (works for both system and user labels)
        const result = await mailApi.messages.removeLabel(accountId, message.id, labelName);
        if (result.success) {
          const newLabels = messageLabels.filter((l) => l !== labelName);
          setMessageLabels(newLabels);
          onLabelsChange?.(newLabels);
          toast.success(t.mail.messageDetail.labelRemoved.replace('{label}', labelName));
        } else {
          toast.error(result.error || t.mail.messageDetail.failedToUpdateLabels);
        }
      } else {
        // Add label (works for both system and user labels)
        const result = await mailApi.messages.addLabel(accountId, message.id, labelName);
        if (result.success) {
          const newLabels = [...messageLabels, labelName];
          setMessageLabels(newLabels);
          onLabelsChange?.(newLabels);
          toast.success(t.mail.messageDetail.labelAdded.replace('{label}', labelName));
        } else {
          toast.error(result.error || t.mail.messageDetail.failedToUpdateLabels);
        }
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToUpdateLabels);
    } finally {
      setIsUpdatingLabels(false);
    }
  };

  const allRecipients = [
    ...(Array.isArray(newestMessage.to) ? newestMessage.to : [newestMessage.to]).map(email => ({ email, type: 'To' as const })),
    ...((newestMessage.cc || []) as string[]).map(email => ({ email, type: 'Cc' as const })),
  ];
  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899'];

  // Get the RFC messageId for the message being replied to (for inReplyTo header)
  const getReplyToRfcMessageId = (): string | undefined => {
    if (!replyToMessageId) return undefined;
    const allMsgs = [message, ...localThread];
    const target = allMsgs.find(m => m.id === replyToMessageId);
    return target?.messageId || undefined;
  };

  const renderComposeBox = (inThread = false) => {
    const isReply = isReplying;
    const placeholder = isReply ? t.mail.messageDetail.replyPlaceholder : t.mail.messageDetail.forwardMessagePlaceholder;
    const onCancel = () => {
      setIsReplying(false);
      setIsForwarding(false);
      setReplyToMessageId(null);
      setComposeData({ to: '', subject: '', body: '' });
      setIsAutoDraft(false);
      setShowInlineAiInput(false);
      setInlineAiPrompt('');
      if (editorRef.current) editorRef.current.innerHTML = '';
    };
    const onSend = isReply ? handleSendReply : handleSendForward;
    const sendDisabled = isSending;

    if (!isReplying && !isForwarding) return null;

    const execCommand = (command: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      setActiveFormats({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
      });
    };

    return (
      <div className={cn("rounded-lg border border-border bg-white dark:bg-card mb-3 mt-4", !inThread && "mx-3 md:mx-4")}>
        {/* To field */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="text-xs text-muted-foreground font-medium">{t.mail.messageDetail.toPrefix}</span>
          <input
            type="text"
            className="flex-1 text-sm outline-none bg-transparent min-w-0 text-foreground"
            value={composeData.to}
            onChange={(e) => setComposeData(prev => ({ ...prev, to: e.target.value }))}
            autoFocus={!isReply}
          />
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              title={t.mail.messageDetail.minimizeToPanel}
              onClick={() => {
                const htmlContent = editorRef.current?.innerHTML || '';
                const textContent = editorRef.current?.textContent || '';
                composeContext?.openCompose({
                  to: composeData.to,
                  subject: composeData.subject || message.subject,
                  body: htmlContent || textContent,
                  inReplyTo: isReply ? getReplyToRfcMessageId() : undefined,
                  accountId,
                }, window.location.pathname);
                onCancel();
              }}
            >
              <PictureInPicture2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              title={t.mail.messageDetail.expandToFullScreen}
              onClick={() => {
                const htmlContent = editorRef.current?.innerHTML || '';
                const textContent = editorRef.current?.textContent || '';
                const rfcMessageId = isReply ? getReplyToRfcMessageId() : undefined;
                if (composeContext) {
                  composeContext.setPreviousUrl(window.location.pathname);
                  composeContext.updateComposeData({
                    to: composeData.to,
                    subject: composeData.subject || message.subject,
                    body: htmlContent || textContent,
                    inReplyTo: rfcMessageId,
                  });
                }
                onCancel();
                // Pass inReplyTo and returnUrl via URL params for reliability
                const params = new URLSearchParams();
                if (rfcMessageId) params.set('inReplyTo', rfcMessageId);
                params.set('returnUrl', window.location.pathname);
                const qs = params.toString();
                router.push(`/weldmail/${accountId}/${folder}/compose${qs ? `?${qs}` : ''}`);
              }}
            >
              <Maximize className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        </div>
        <div className="mx-3 border-t border-border/50" />
        {/* Message body */}
        <div className={cn("px-3 py-2.5", isAutoDraft && !isAgentInline && "mx-3 mt-2.5 rounded-lg border border-purple-200/60 dark:border-purple-500/20 bg-gradient-to-br from-purple-50/50 via-blue-50/30 to-violet-50/40 dark:from-purple-950/20 dark:via-blue-950/10 dark:to-violet-950/15 px-3 py-3")}>
          <div
            ref={editorRef}
            contentEditable
            data-placeholder={placeholder}
            className="w-full min-h-36 text-sm outline-none bg-transparent text-foreground empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60 mt-px"
            onFocus={(e) => { if (isReply && !e.currentTarget.textContent) e.currentTarget.focus(); }}
            suppressContentEditableWarning
          />
        </div>
        {/* Actions bar */}
        {isAutoDraft ? (
          <>
            <div className={cn("flex items-center gap-2 px-3 py-3", isAgentInline && "border-t border-border/50")}>
              <PenLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <textarea
                ref={inlineAiInputRef}
                value={inlineAiPrompt}
                onChange={(e) => {
                  setInlineAiPrompt(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = e.target.scrollHeight + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!inlineAiPrompt.trim() || isInlineAiGenerating) return;
                    setIsInlineAiGenerating(true);
                    generateAIReplyMutation.mutateAsync({ userPrompt: inlineAiPrompt, messageId: replyToMessageId || undefined, accountId })
                      .then((result) => {
                        if (result.success && result.body && editorRef.current) {
                          editorRef.current.innerHTML = formatAiBody(result.body);
                          setIsAgentInline(false);
                          toast.success(t.mail.messageDetail.draftUpdated);
                        } else {
                          toast.error(t.mail.messageDetail.failedToUpdateDraft);
                        }
                      })
                      .catch((err) => {
                        if (!handleAiCreditsError(err)) toast.error(t.mail.messageDetail.failedToUpdateDraft);
                      })
                      .finally(() => {
                        setIsInlineAiGenerating(false);
                        setInlineAiPrompt('');
                      });
                  }
                  if (e.key === 'Escape') {
                    setIsAutoDraft(false);
                    setIsAgentInline(false);
                    setShowInlineAiInput(false);
                    setInlineAiPrompt('');
                  }
                }}
                placeholder={editorRef.current?.textContent?.trim() ? t.mail.messageDetail.aiEditPlaceholder : t.mail.messageDetail.aiReplyPlaceholder}
                className="flex-1 text-sm outline-none bg-transparent placeholder-muted-foreground/60 resize-none overflow-hidden min-h-[24px] mt-[3px] ml-[3px]"
                rows={1}
              />
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Button variant="outline" size="sm" onClick={() => {
                  if (isAgentInline) {
                    setIsAutoDraft(false);
                    setIsAgentInline(false);
                    setShowInlineAiInput(false);
                    setInlineAiPrompt('');
                  } else {
                    onCancel();
                  }
                }}>
                  {t.mail.messageDetail.cancelButton}
                </Button>
                {inlineAiPrompt.trim() ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!inlineAiPrompt.trim() || isInlineAiGenerating) return;
                      setIsInlineAiGenerating(true);
                      generateAIReplyMutation.mutateAsync({ userPrompt: inlineAiPrompt, messageId: replyToMessageId || undefined, accountId })
                        .then((result) => {
                          if (result.success && result.body && editorRef.current) {
                            editorRef.current.innerHTML = formatAiBody(result.body);
                            setIsAgentInline(false);
                            toast.success(editorRef.current.textContent?.trim() ? t.mail.messageDetail.draftUpdated : t.mail.messageDetail.aiContentGenerated);
                          } else {
                            toast.error(t.mail.messageDetail.failedToGenerateContent);
                          }
                        })
                        .catch((err) => {
                          if (!handleAiCreditsError(err)) toast.error(t.mail.messageDetail.failedToGenerateContent);
                        })
                        .finally(() => {
                          setIsInlineAiGenerating(false);
                          setInlineAiPrompt('');
                        });
                    }}
                    disabled={isInlineAiGenerating}
                  >
                    {isInlineAiGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : t.mail.messageDetail.createButton}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      setIsAutoDraft(false);
                      setShowInlineAiInput(false);
                      setInlineAiPrompt('');
                    }}
                  >
                    {t.mail.messageDetail.insertButton}
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between px-3 py-3 border-t border-border/50">
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", activeFormats.bold ? "bg-muted" : "hover:bg-muted")} title={t.mail.toolbar.bold} onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }}>
                <Bold className={cn("h-4 w-4", activeFormats.bold ? "text-foreground" : "text-muted-foreground")} />
              </Button>
              <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", activeFormats.italic ? "bg-muted" : "hover:bg-muted")} title={t.mail.toolbar.italic} onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }}>
                <Italic className={cn("h-4 w-4", activeFormats.italic ? "text-foreground" : "text-muted-foreground")} />
              </Button>
              <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", activeFormats.underline ? "bg-muted" : "hover:bg-muted")} title={t.mail.toolbar.underline} onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }}>
                <Underline className={cn("h-4 w-4", activeFormats.underline ? "text-foreground" : "text-muted-foreground")} />
              </Button>
              <div className="w-px h-5 bg-border mx-0.5" />
              <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", activeFormats.insertUnorderedList ? "bg-muted" : "hover:bg-muted")} title={t.mail.toolbar.bulletList} onMouseDown={(e) => { e.preventDefault(); execCommand('insertUnorderedList'); }}>
                <List className={cn("h-4 w-4", activeFormats.insertUnorderedList ? "text-foreground" : "text-muted-foreground")} />
              </Button>
              <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", activeFormats.insertOrderedList ? "bg-muted" : "hover:bg-muted")} title={t.mail.toolbar.numberedList} onMouseDown={(e) => { e.preventDefault(); execCommand('insertOrderedList'); }}>
                <ListOrdered className={cn("h-4 w-4", activeFormats.insertOrderedList ? "text-foreground" : "text-muted-foreground")} />
              </Button>
              <div className="w-px h-5 bg-border mx-0.5" />
              <Button variant="ghost" size="icon" className="p-2 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.attachFile} onMouseDown={(e) => { e.preventDefault(); toast.success(t.mail.messageDetail.attachFile); }}>
                <Paperclip className="h-4 w-4 text-muted-foreground" />
              </Button>
              <Button variant="ghost" size="icon" className="p-2 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.insertLink} onMouseDown={(e) => {
                e.preventDefault();
                const url = prompt('Enter URL:');
                if (url) execCommand('createLink', url);
              }}>
                <Link className="h-4 w-4 text-muted-foreground" />
              </Button>
              <div className="w-px h-5 bg-border mx-0.5" />
              <Button
                variant="ghost"
                size="icon"
                className="p-2 hover:bg-muted rounded-md transition-colors"
                title={t.mail.toolbar.aiAssistant}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsAutoDraft(true);
                  setIsAgentInline(true);
                  setShowInlineAiInput(true);
                  setInlineAiPrompt('');
                  setTimeout(() => inlineAiInputRef.current?.focus(), 0);
                }}
              >
                <img src="/assets/images/weldagent/logo-light.png" alt="WeldAgent" className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={onCancel}>
                {t.mail.messageDetail.cancelButton}
              </Button>
              <Button size="sm" onClick={onSend} disabled={sendDisabled}>
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : t.mail.compose.send}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-background overflow-hidden">
      {/* Top Header Bar with Subject and Actions */}
      <div className="flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Mobile back button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 rounded-md transition-colors flex-shrink-0"
            onClick={handleBackToList}
            aria-label={t.mail.messageDetail.backToList}
          >
            <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
          </Button>
          {/* Desktop close/done buttons */}
          <div className="hidden md:flex items-center border border-border rounded-md overflow-hidden">
            <Button variant="ghost" size="icon" className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors" onClick={() => window.history.back()}>
              <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button variant="ghost" size="icon" className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors" onClick={async () => {
              await handleArchive();
              handleBackToList();
            }}>
              <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
            </Button>
          </div>
          <h1 className="text-sm md:text-lg font-semibold text-gray-900 dark:text-foreground md:ml-2 truncate">{message.subject}</h1>
          {/* Label badges - hidden on mobile */}
          {messageLabels.length > 0 && (
            <div className="hidden md:flex gap-1.5 ml-2">
              {messageLabels.slice(0, 8).map((labelName) => {
                const labelData = availableLabels.find((l) => l.name === labelName);
                const color = getLabelColor(labelName, labelData);
                return (
                  <span
                    key={labelName}
                    className="relative px-2 py-0.5 rounded text-[12px] font-medium cursor-default group"
                    style={{
                      backgroundColor: `${color}15`,
                      color: color,
                    }}
                  >
                    {labelName}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => { e.stopPropagation(); handleToggleLabel(labelName); }}
                      className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded-full bg-background border border-border shadow-sm hover:bg-muted transition-opacity"
                    >
                      <X className="h-2.5 w-2.5 text-muted-foreground" />
                    </Button>
                  </span>
                );
              })}
              {messageLabels.length > 8 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted rounded transition-colors">
                      +{messageLabels.length - 8}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="flex flex-col gap-1.5">
                      {messageLabels.slice(8).map((labelName) => {
                        const labelData = availableLabels.find((l) => l.name === labelName);
                        const color = getLabelColor(labelName, labelData);
                        return (
                          <span
                            key={labelName}
                            className="relative px-2 py-0.5 rounded text-[12px] font-medium cursor-default group"
                            style={{
                              backgroundColor: `${color}15`,
                              color: color,
                            }}
                          >
                            {labelName}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => { e.stopPropagation(); handleToggleLabel(labelName); }}
                              className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded-full bg-background border border-border shadow-sm hover:bg-muted transition-opacity"
                            >
                              <X className="h-2.5 w-2.5 text-muted-foreground" />
                            </Button>
                          </span>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {/* Essential actions visible on mobile */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggleStar}
            className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", isStarred && "text-yellow-500")}
          >
            <Star className={cn("h-4 w-4", isStarred ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
          </Button>
          {/* Pin button - hidden on mobile */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleTogglePin}
            className={cn("hidden md:flex p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", isPinned && "text-blue-500")}
            title={isPinned ? t.mail.messageDetail.unpin : t.mail.messageDetail.pin}
          >
            <Pin className={cn("h-4 w-4", isPinned ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleArchive}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
            title={threadId ? t.mail.messageDetail.archiveConversation : t.mail.messageDetail.archivedSingle}
          >
            <Archive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          </Button>
          {/* Snooze button - hidden on mobile */}
          <Button variant="ghost" size="icon" className="hidden md:flex p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors" onClick={() => toast.success(t.mail.messageDetail.snoozeComingSoon)}>
            <Clock className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          </Button>
          {/* Labels popover - hidden on mobile */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="hidden md:flex p-1.5 hover:bg-gray-100 dark:hover:bg-secondary data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-secondary rounded-md transition-colors items-center gap-1 text-gray-500 dark:text-muted-foreground">
                <Tag className="h-4 w-4" />
                {messageLabels.length > 0 && (
                  <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
                    {messageLabels.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" align="end">
              {/* System Labels */}
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 px-2">{t.mail.messageDetail.systemLabels}</div>
              <div className="space-y-0.5 mb-3">
                {/* Inbox */}
                {(() => {
                  const hasInbox = messageLabels.includes('inbox');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('inbox')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasInbox ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <Inbox className={cn("h-4 w-4 flex-shrink-0", hasInbox ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelInbox}</span>
                      {hasInbox && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Starred */}
                {(() => {
                  const hasStarred = messageLabels.includes('starred');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('starred')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasStarred ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <Star className={cn("h-4 w-4 flex-shrink-0", hasStarred ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelStarred}</span>
                      {hasStarred && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Important */}
                {(() => {
                  const hasImportant = messageLabels.includes('important');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('important')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasImportant ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <Flag className={cn("h-4 w-4 flex-shrink-0", hasImportant ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelImportant}</span>
                      {hasImportant && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Sent */}
                {(() => {
                  const hasSent = messageLabels.includes('sent');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('sent')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasSent ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <Send className={cn("h-4 w-4 flex-shrink-0", hasSent ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelSent}</span>
                      {hasSent && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Archive */}
                {(() => {
                  const hasArchive = messageLabels.includes('archive');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('archive')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasArchive ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <Archive className={cn("h-4 w-4 flex-shrink-0", hasArchive ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelArchive}</span>
                      {hasArchive && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Spam */}
                {(() => {
                  const hasSpam = messageLabels.includes('spam');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('spam')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasSpam ? "bg-gray-100" : "hover:bg-gray-100"
                      )}
                    >
                      <AlertTriangle className={cn("h-4 w-4 flex-shrink-0", hasSpam ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelSpam}</span>
                      {hasSpam && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
                {/* Trash */}
                {(() => {
                  const hasTrash = messageLabels.includes('trash');
                  return (
                    <Button
                      variant="ghost"
                      onClick={() => handleToggleLabel('trash')}
                      disabled={isUpdatingLabels}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                        hasTrash ? "bg-gray-200" : "hover:bg-gray-100"
                      )}
                    >
                      <Trash className={cn("h-4 w-4 flex-shrink-0", hasTrash ? "text-gray-600" : "text-gray-500")} />
                      <span className="flex-1 text-left">{t.mail.messageDetail.labelTrash}</span>
                      {hasTrash && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
                    </Button>
                  );
                })()}
              </div>

              {/* User Labels */}
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 px-2">{t.mail.messageDetail.customLabels}</div>
              {availableLabels.length === 0 ? (
                <div className="text-sm text-gray-400 py-2 px-2">
                  {t.mail.messageDetail.noCustomLabels}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {availableLabels.map((label) => {
                    const isApplied = messageLabels.includes(label.name);
                    const color = getLabelColor(label.name, label);
                    return (
                      <Button
                        variant="ghost"
                        key={label.name}
                        onClick={() => handleToggleLabel(label.name)}
                        disabled={isUpdatingLabels}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                          isApplied ? "bg-gray-100" : "hover:bg-gray-100"
                        )}
                      >
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="flex-1 text-left truncate">{label.name}</span>
                        {isApplied && (
                          <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />
                        )}
                      </Button>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            onClick={handleDelete}
            className="p-1.5 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md transition-colors group/delete"
            title={threadId ? t.mail.messageDetail.deleteConversation : t.mail.messageDetail.movedSingleToTrash}
          >
            <Trash2 className="h-4 w-4 text-gray-500 dark:text-muted-foreground group-hover/delete:text-red-500 transition-colors" />
          </Button>
        </div>
      </div>

      {/* Scheduled Email Banner */}
      {message.sendStatus === 'scheduled' && message.scheduledFor && (
        <ScheduledBanner
          messageId={message.id}
          scheduledFor={message.scheduledFor}
          accountId={accountId}
          folder={folder}
        />
      )}

      {/* Scrollable Content Area */}
      <div
        className={cn(
          "flex-1 overflow-y-auto transition-all duration-300",
          customerPanel.isOpen && "md:mr-[500px]"
        )}
      >
        {/* Reply/Forward compose - above newest message */}
        {(isReplying || isForwarding) && replyToMessageId === newestMessage.id && renderComposeBox()}

        {/* Draft replies to the newest message - shown above it */}
        {drafts.filter(d => d.inReplyTo === newestMessage.messageId).map((draft) => (
          <div
            key={draft.id}
            className="mx-3 md:mx-4 mb-3 group relative border border-orange-200 rounded-lg bg-orange-50/50 cursor-pointer hover:bg-orange-50 transition-colors"
            onClick={() => {
              router.push(`/weldmail/${accountId}/${folder}/compose?draftId=${draft.id}&returnUrl=${encodeURIComponent(window.location.pathname)}`);
            }}
          >
            <div className="px-3 md:px-4 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="w-6 h-6 rounded-md flex items-center justify-center bg-orange-100 flex-shrink-0">
                  <FileText className="h-3.5 w-3.5 text-orange-600" />
                </div>
                <div className="min-w-0 text-left flex items-center gap-2 flex-1">
                  <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-orange-100 text-orange-700 hover:bg-orange-100 flex-shrink-0">{t.mail.messageDetail.draft}</Badge>
                  <span className="text-sm text-muted-foreground truncate">
                    {draft.to.length > 0 ? `${t.mail.messageDetail.toPrefix}: ${draft.to.join(', ')}` : t.mail.messageDetail.noRecipients}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-muted-foreground">{format(new Date(draft.updatedAt), 'MMM d, h:mm a')}</span>
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteDraftMutation.mutate(draft.id, {
                      onSuccess: () => {
                        toast.success(t.mail.messageDetail.draftDeleted);
                      },
                      onError: () => {
                        toast.error(t.mail.messageDetail.failedToDeleteDraft);
                      },
                    });
                  }}
                  className="p-1 opacity-0 group-hover:opacity-100 hover:bg-orange-100 rounded-md transition-all"
                  title={t.mail.messageDetail.deleteDraft}
                >
                  <Trash className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
            {(draft.body || draft.htmlBody) && (
              <div className="px-3 md:px-4 pb-3 pt-0">
                <div className="text-sm text-muted-foreground truncate">
                  {draft.body?.replace(/<[^>]*>/g, '').substring(0, 150) || draft.htmlBody?.replace(/<[^>]*>/g, '').substring(0, 150)}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Sender Header */}
        <div className="px-3 md:px-4 py-3 md:py-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              {(() => {
                const avatarUrl = getSenderAvatarUrl(newestMessage);
                return avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={extractName(newestMessage.from || '')}
                    className="w-6 h-6 rounded-md object-cover flex-shrink-0"
                  />
                ) : (
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
                    style={{ backgroundColor: getAvatarColor(newestMessage.from || '') }}
                  >
                    {(newestMessage.from || '?').charAt(0).toUpperCase()}
                  </div>
                );
              })()}
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    onClick={() => customerPanel.openPanel(newestMessage.fromEmail || extractEmail(newestMessage.from || ''), extractName(newestMessage.from || ''))}
                    className="font-semibold text-gray-900 dark:text-foreground text-[14.5px] hover:underline focus:outline-none"
                  >
                    {extractName(newestMessage.from || '')}
                  </Button>
                  <span className="text-[14.5px] text-gray-500 dark:text-muted-foreground">{t.mail.messageDetail.toWord}</span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const toEmail = (Array.isArray(newestMessage.to) ? newestMessage.to : [newestMessage.to])[0];
                      const toName = toEmail.split('@')[0].split('.').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
                      customerPanel.openPanel(toEmail, toName);
                    }}
                    className="text-[14.5px] text-blue-600 hover:underline focus:outline-none"
                  >
                    {(Array.isArray(newestMessage.to) ? newestMessage.to : [newestMessage.to])[0]}
                  </Button>
                  {allRecipients.length > 1 && (
                    <Popover open={showAllRecipients} onOpenChange={setShowAllRecipients}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" className="text-sm text-blue-600 hover:underline">
                          +{allRecipients.length - 1}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 p-0" align="start">
                        <div className="px-3 py-2 border-b">
                          <p className="text-xs font-medium text-gray-500">{t.mail.messageDetail.recipients.replace('{n}', String(allRecipients.length))}</p>
                        </div>
                        <div className="p-2 space-y-1">
                          {allRecipients.map((recipient, index) => {
                            const name = recipient.email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
                            const initials = name.split(' ').map(n => n[0]).join('').substring(0, 2);
                            return (
                              <Button
                                variant="ghost"
                                key={index}
                                onClick={() => {
                                  setShowAllRecipients(false);
                                  customerPanel.openPanel(recipient.email, name);
                                }}
                                className="flex items-center gap-3 w-full text-left hover:bg-gray-100 px-2 py-1.5 rounded-md"
                              >
                                <Avatar className="h-7 w-7">
                                  <AvatarFallback className="text-xs text-white" style={{ backgroundColor: colors[index % colors.length] }}>
                                    {initials}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{name}</div>
                                  <div className="text-xs text-gray-500 flex items-center gap-1">
                                    {recipient.email}
                                    {recipient.type === 'Cc' && <span className="text-[10px] px-1 bg-gray-100 rounded">CC</span>}
                                  </div>
                                </div>
                              </Button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-gray-500 flex-shrink-0">
              <span className="text-sm text-gray-700">{format(new Date(newestMessage.date), 'd MMM, HH:mm')}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="p-1 hover:bg-gray-100 data-[state=open]:bg-gray-100 rounded-md transition-colors focus:outline-none focus-visible:outline-none">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => handleMarkAsRead(false)}>
                    <Eye className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.markAsUnread}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleToggleStar}>
                    <Star className={cn("mr-0.5 h-4 w-4", isStarred && "text-yellow-500 fill-yellow-500")} /> {isStarred ? t.mail.messageDetail.removeStar : t.mail.messageDetail.addStar}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleSetImportance}>
                    <Flag className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.markAsImportant}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(message.id || ''); toast.success(t.mail.messageDetail.messageIdCopied); }}>
                    <Copy className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.copyMessageId}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    window.open(window.location.href, '_blank');
                  }}>
                    <ExternalLink className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.openInNewWindow}
                  </DropdownMenuItem>
                  {/*
                    "Download email" (.eml) is intentionally absent. It pointed at
                    `/api/mail/accounts/:accountId/messages/:id/download` on the legacy
                    worker, which never mounted a mail surface at all — so the anchor
                    navigated to a 404 (and, being a bare <a href>, carried no Clerk
                    token either). app-api has no whole-message download endpoint:
                    `/api/mail-messages` exposes read/update/delete only. Restoring this
                    means building that route first — `mailMessages.rawMessage` is
                    nullable, so it also needs a real .eml source. Per-attachment
                    downloads are unaffected; they use the stored `downloadUrl` below.
                  */}
                  <DropdownMenuItem onClick={() => toast.success(t.mail.messageDetail.creatingFilter)}>
                    <ListFilter className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.filterMessagesLikeThis}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={userLabels.length === 0} className="gap-2">
                      <Tag className="h-4 w-4 mr-0.5" /> {t.mail.messageDetail.labelAs}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                      {userLabels.length === 0 ? (
                        <DropdownMenuItem disabled>{t.mail.messageDetail.noLabelsAvailable}</DropdownMenuItem>
                      ) : (
                        userLabels.map((l) => (
                          <DropdownMenuItem
                            key={l.id}
                            onClick={() => {
                              mailApi.messages.update(accountId, message.id, {
                                labels: [...(message.labels || []), l.name],
                              }).then(() => toast.success(t.mail.messageDetail.labelAddedNamed.replace('{label}', l.name)));
                            }}
                          >
                            {l.color && (
                              <span className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: l.color }} />
                            )}
                            {l.name}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleArchive}>
                    <Archive className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.labelArchive}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleMarkAsSpam}>
                    {isInSpamFolder ? (
                      <><Inbox className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.notSpam}</>
                    ) : (
                      <><AlertTriangle className="mr-0.5 h-4 w-4" /> {t.mail.messageDetail.markAsSpamAction}</>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleDelete} className="text-red-600 focus:bg-red-50 focus:text-red-600">
                    <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" /> {isInTrashFolder ? t.mail.messageDetail.deletePermanently : t.mail.messageDetail.moveToTrash}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Email Content */}
        <div className="px-3 md:px-4 group/email">
          <div className="text-gray-700 dark:text-foreground text-sm leading-relaxed overflow-x-auto">
            {mainContent ? (
              isHtml ? (
                <IsolatedHtmlContent html={mainContent} />
              ) : (
                <div className="whitespace-pre-wrap">{mainContent}</div>
              )
            ) : newestMessage.bodyHtml ? (
              <IsolatedHtmlContent html={newestMessage.bodyHtml} />
            ) : newestMessage.bodyText ? (
              <div className="whitespace-pre-wrap">{newestMessage.bodyText}</div>
            ) : (
              <div className="text-gray-400 italic">{t.mail.messageDetail.noContent}</div>
            )}
            {quotedContent && (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setShowQuoted(!showQuoted)}
                  className={cn("mt-2 inline-flex items-center justify-center h-5 w-8 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md hover:bg-muted-foreground/20 transition-all", !showQuoted && "opacity-0 group-hover/email:opacity-100")}
                  title={showQuoted ? t.mail.messageDetail.hideQuotedText : t.mail.messageDetail.showQuotedText}
                >
                  ···
                </Button>
                {showQuoted && (
                  <div className="mt-2">
                    {isHtml ? (
                      <IsolatedHtmlContent html={quotedContent} />
                    ) : (
                      <div className="whitespace-pre-wrap">{quotedContent}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Calendar invites (.ics) — offer a one-click add to Weld Calendar */}
          {calendarInvites.length > 0 && (
            <div className="mt-4 md:mt-6 space-y-2">
              {calendarInvites.map((att) => (
                <CalendarInviteCard
                  key={att.id}
                  attachmentId={att.id}
                  downloadUrl={att.downloadUrl}
                  fileName={att.fileName}
                  size={att.size}
                />
              ))}
            </div>
          )}

          {/* Attachments */}
          {newestMessage.hasAttachments && (
            <div className="mt-4 md:mt-6 space-y-2">
              {attachments.length > 0 ? (
                otherAttachments.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                      <Paperclip className="h-3.5 w-3.5" />
                      <span>{otherAttachments.length !== 1 ? t.mail.messageDetail.attachmentCountPlural.replace('{n}', String(otherAttachments.length)) : t.mail.messageDetail.attachmentCount.replace('{n}', String(otherAttachments.length))}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {otherAttachments.map((att) => (
                        <a
                          key={att.id}
                          href={att.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-border bg-white dark:bg-card hover:bg-gray-50 dark:hover:bg-secondary transition-colors text-sm group"
                        >
                          <FileDown className="h-4 w-4 text-gray-400 group-hover:text-gray-600" />
                          <span className="text-gray-700 truncate max-w-[200px]">{att.fileName}</span>
                          <span className="text-gray-400 text-xs whitespace-nowrap">
                            {att.size < 1024 ? `${att.size} B` : att.size < 1048576 ? `${Math.round(att.size / 1024)} KB` : `${(att.size / 1048576).toFixed(1)} MB`}
                          </span>
                        </a>
                      ))}
                    </div>
                  </>
                )
              ) : (
                <div className="text-sm text-gray-400">{t.mail.messageDetail.loadingAttachments}</div>
              )}
            </div>
          )}

          {/* Reply, Forward, and Auto Draft Buttons */}
          <div className="flex items-center justify-end gap-2 mt-4 md:mt-6">
            <Button
              variant="ghost"
              onClick={async () => {
                setIsAutoGenerating(true);
                try {
                  const result = await generateAutoDraftMutation.mutateAsync({ messageId: newestMessage.id, accountId });
                  if (result.success && result.draft) {
                    const wasAlreadyReplying = isReplying && replyToMessageId === newestMessage.id;
                    setIsReplying(true);
                    setIsForwarding(false);
                    setReplyToMessageId(newestMessage.id);
                    setComposeData({
                      to: newestMessage.fromEmail || newestMessage.from || '',
                      subject: result.draft.subject || `Re: ${message.subject}`,
                      body: result.draft.body,
                    });
                    setIsAutoDraft(true);
                    setIsAgentInline(false);
                    setShowInlineAiInput(true);
                    setInlineAiPrompt('');
                    // If compose box was already open, update editor immediately
                    if (wasAlreadyReplying && editorRef.current) {
                      editorRef.current.innerHTML = formatAiBody(result.draft.body);
                      inlineAiInputRef.current?.focus();
                    } else {
                      // Wait for compose box to mount
                      setTimeout(() => {
                        if (editorRef.current) {
                          editorRef.current.innerHTML = formatAiBody(result.draft!.body);
                        }
                        inlineAiInputRef.current?.focus();
                      }, 150);
                    }
                    toast.success(t.mail.messageDetail.draftUpdated);
                  } else {
                    toast.error(result.error || t.mail.messageDetail.failedToUpdateDraft);
                  }
                } catch (err) {
                  if (!handleAiCreditsError(err)) toast.error(t.mail.messageDetail.failedToUpdateDraft);
                } finally {
                  setIsAutoGenerating(false);
                }
              }}
              disabled={isAutoGenerating}
              className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isAutoGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <img src="/assets/images/weldagent/logo-light.png" alt="WeldAgent" className="h-4 w-4" />}
              <span className="text-sm">{t.mail.messageDetail.autoDraft}</span>
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const wasReplying = isReplying && replyToMessageId === newestMessage.id;
                setIsReplying(!wasReplying);
                setIsForwarding(false);
                setReplyToMessageId(!wasReplying ? newestMessage.id : null);
                if (!wasReplying) {
                  setComposeData({ to: newestMessage.fromEmail || newestMessage.from || '', subject: `Re: ${message.subject}`, body: '' });
                }
              }}
              className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2"
            >
              <Reply className="h-4 w-4" />
              <span className="text-sm">{t.mail.compose.reply}</span>
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const wasForwarding = isForwarding && replyToMessageId === newestMessage.id;
                setIsForwarding(!wasForwarding);
                setIsReplying(false);
                setReplyToMessageId(!wasForwarding ? newestMessage.id : null);
                if (!wasForwarding) {
                  setComposeData({ to: '', subject: `Fwd: ${message.subject}`, body: '' });
                }
              }}
              className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2"
            >
              <Forward className="h-4 w-4" />
              <span className="text-sm">{t.mail.compose.forward}</span>
            </Button>
          </div>
        </div>

        {/* Previous Conversations */}
        {olderMessages.length > 0 && (
          <div className="px-3 md:px-4 pt-4 mb-4">
            <div className="space-y-4">
              {olderMessages.map((threadMsg) => {
                const isExpanded = expandedThreadIds.has(threadMsg.id);
                const isSentMessage = threadMsg.folder?.toLowerCase() === 'sent';
                return (
                  <React.Fragment key={threadMsg.id}>
                    {/* Reply/Forward compose - above this thread message */}
                    {(isReplying || isForwarding) && replyToMessageId === threadMsg.id && renderComposeBox(true)}
                    {/* Draft replies to this thread message */}
                    {drafts.filter(d => d.inReplyTo === threadMsg.messageId).map((draft) => (
                      <div
                        key={draft.id}
                        className="group/draft relative border border-orange-200 rounded-lg bg-orange-50/50 cursor-pointer hover:bg-orange-50 transition-colors mb-2"
                        onClick={() => {
                          router.push(`/weldmail/${accountId}/${folder}/compose?draftId=${draft.id}&returnUrl=${encodeURIComponent(window.location.pathname)}`);
                        }}
                      >
                        <div className="px-3 md:px-4 py-4 flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <div className="w-6 h-6 rounded-md flex items-center justify-center bg-orange-100 flex-shrink-0">
                              <FileText className="h-3.5 w-3.5 text-orange-600" />
                            </div>
                            <div className="min-w-0 text-left flex items-center gap-2 flex-1">
                              <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-orange-100 text-orange-700 hover:bg-orange-100 flex-shrink-0">{t.mail.messageDetail.draft}</Badge>
                              <span className="text-sm text-muted-foreground truncate">
                                {draft.to.length > 0 ? `${t.mail.messageDetail.toPrefix}: ${draft.to.join(', ')}` : t.mail.messageDetail.noRecipients}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-xs text-muted-foreground">{format(new Date(draft.updatedAt), 'MMM d, h:mm a')}</span>
                            <Button
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteDraftMutation.mutate(draft.id, {
                                  onSuccess: () => {
                                    toast.success(t.mail.messageDetail.draftDeleted);
                                  },
                                  onError: () => {
                                    toast.error(t.mail.messageDetail.failedToDeleteDraft);
                                  },
                                });
                              }}
                              className="p-1 opacity-0 group-hover/draft:opacity-100 hover:bg-orange-100 rounded-md transition-all"
                              title={t.mail.messageDetail.deleteDraft}
                            >
                              <Trash className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </div>
                        </div>
                        {(draft.body || draft.htmlBody) && (
                          <div className="px-3 md:px-4 pb-3 pt-0">
                            <div className="text-sm text-muted-foreground truncate">
                              {draft.body?.replace(/<[^>]*>/g, '').substring(0, 150) || draft.htmlBody?.replace(/<[^>]*>/g, '').substring(0, 150)}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  <div className="group relative border border-border/50 rounded-lg bg-muted/50">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleThreadExpanded(threadMsg.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleThreadExpanded(threadMsg.id);
                        }
                      }}
                      className="w-full px-3 md:px-4 py-4 flex items-center justify-between hover:bg-muted/50 transition-colors rounded-lg cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const email = threadMsg.fromEmail || extractEmail(threadMsg.from || '');
                            customerPanel.openPanel(email, extractName(threadMsg.from || ''));
                          }}
                          className="flex items-center gap-2 min-w-0 rounded-md focus:outline-none group/sender"
                          title={t.mail.messageDetail.viewContactDetails}
                        >
                          {(() => {
                            const threadAvatarUrl = getSenderAvatarUrl(threadMsg);
                            return threadAvatarUrl ? (
                              <img
                                src={threadAvatarUrl}
                                alt={extractName(threadMsg.from || '')}
                                className="w-6 h-6 rounded-md object-cover flex-shrink-0"
                              />
                            ) : (
                              <div
                                className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs font-medium flex-shrink-0"
                                style={{ backgroundColor: getAvatarColor(threadMsg.from || '') }}
                              >
                                {(threadMsg.from || 'U').charAt(0).toUpperCase()}
                              </div>
                            );
                          })()}
                          <span className="text-sm font-medium text-foreground truncate group-hover/sender:underline">
                            {threadMsg.from}
                          </span>
                        </Button>
                        {isSentMessage && (
                          <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-pink-100 text-pink-700 hover:bg-pink-100 flex-shrink-0">{t.mail.messageDetail.sentBadge}</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="hidden md:inline text-xs text-muted-foreground">{format(new Date(threadMsg.date), 'MMM d, yyyy h:mm a')}</span>
                        <span className="md:hidden text-xs text-muted-foreground">{format(new Date(threadMsg.date), 'MMM d')}</span>
                        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", isExpanded && "rotate-180")} />
                      </div>
                    </div>
                    {isExpanded && (
                      <ThreadMessageContent threadMsg={threadMsg} />
                    )}
                    {/* Hover Actions - only when expanded, hidden on mobile */}
                    <div className={cn("absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity hidden md:flex items-center gap-1", !isExpanded && "!hidden")}>
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsReplying(true);
                          setIsForwarding(false);
                          setReplyToMessageId(threadMsg.id);
                          setComposeData({ to: threadMsg.fromEmail || threadMsg.from || '', subject: `Re: ${threadMsg.subject || message.subject}`, body: '' });
                        }}
                        className="p-1.5 bg-white dark:bg-card border border-border rounded-md hover:bg-muted transition-colors"
                        title={t.mail.compose.reply}
                      >
                        <Reply className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          toast.success(t.mail.messageDetail.forwardComingSoon);
                        }}
                        className="p-1.5 bg-white dark:bg-card border border-border rounded-md hover:bg-muted transition-colors"
                        title={t.mail.compose.forward}
                      >
                        <Forward className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {/* Customer Detail Panel - hidden on mobile */}
      <div className="hidden md:block">
        <CustomerDetailPanel
          email={customerPanel.email || newestMessage.fromEmail || extractEmail(newestMessage.from || '')}
          name={customerPanel.name || extractName(newestMessage.from || '')}
          customerId={customerPanel.customerId || undefined}
          isOpen={customerPanel.isOpen}
          onClose={() => customerPanel.closePanel()}
          onCompose={(email) => {
            customerPanel.closePanel();
            setIsReplying(true);
            setComposeData({ to: email, subject: `Re: ${message.subject}`, body: '' });
          }}
          topOffset="117px"
        />
      </div>

      {/* Add Task Dialog */}
      <TaskDialog
        open={showAddTaskDialog}
        onOpenChange={setShowAddTaskDialog}
        editingTask={null}
        availableAssignees={[]}
        availableCompanies={[]}
        onSave={(data) => {
          toast.success(t.mail.messageDetail.taskCreated.replace('{title}', data.title));
          setShowAddTaskDialog(false);
        }}
        onUpdate={() => {}}
        isPending={false}
      />

    </div>
  );
}
