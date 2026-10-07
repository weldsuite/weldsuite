
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { usePathname, useRouter } from '@/lib/router';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import {
  Reply,
  ReplyAll,
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
import type { LucideIcon } from 'lucide-react';
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
import { useCustomerPanel } from '@/contexts/customer-panel-context';
import { useComposeSafe } from '@/contexts/compose-context';
import { useMailThreadListSafe } from '@/app/weldmail/contexts/mail-thread-list-context';
import { getNextThreadHref } from '@/app/weldmail/lib/next-thread';
import { folderHidesOnArchive } from '@/app/weldmail/lib/optimistic-thread-list';
import { mailApi } from '../lib/api-client';
import { currentMailHref } from '../lib/mail-urls';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { IsolatedHtmlContent } from './isolated-html-content';
import { ComposeAttachButton } from './compose-attach-button';
import {
  MAX_EMAIL_SIZE_BYTES,
  MailAttachmentUploadError,
  emailSizeExceedsLimit,
  uploadMailAttachments,
} from '@/app/weldmail/lib/upload-attachments';
import {
  useArchiveThread,
  useTrashThread,
  useMarkThreadAsSpam,
  useDeleteMailDraft,
  useGenerateAutoDraft,
  useGenerateAIReply,
  useMailAttachments,
  useMailAccounts,
  usePinThread,
  useToggleMailStar,
} from '@/hooks/queries/use-mail-queries';
import { isSystemLabel } from '../lib/label-config';
import { saveMailAttachment } from '../lib/download-attachment';
import type { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';
import { CustomerDetailPanel } from './customer-detail-panel';
import { CalendarInviteCard } from './calendar-invite-card';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';
import { copyText } from '@/lib/clipboard';

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

// `from` may be a plain "Name <email>" string (legacy) or a structured
// Mail.EmailAddress object (some app-api routes already return one); collapse
// down to the string extractName/extractEmail already expect.
function fromDisplayString(from: string | MailTypes.EmailAddress | undefined): string {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

// `to`/`cc`/`bcc` entries may likewise be plain email strings or structured
// Mail.EmailAddress objects; normalize a single entry down to its email.
function addressToEmail(addr: string | MailTypes.EmailAddress | undefined): string {
  if (!addr) return '';
  return typeof addr === 'string' ? addr : addr.email;
}

function addressListToEmails(list?: string[] | MailTypes.EmailAddress[]): string[] {
  return (list || []).map((item) => addressToEmail(item));
}

// Recipients for a reply. A plain reply goes to the original sender only; a
// reply-all adds everyone else who was on the To/Cc lines, minus the mailbox
// we're replying from (replying to yourself is never what's wanted).
// `replyAndPersist` on the server derives the same set from the stored message,
// so what we show here matches what actually gets sent.
function buildReplyRecipients(
  msg: EmailMessage,
  { all, selfEmail }: { all: boolean; selfEmail?: string },
): string[] {
  const self = selfEmail?.trim().toLowerCase();
  const seen = new Set<string>();
  const recipients: string[] = [];
  const add = (email: string, { allowSelf = false } = {}) => {
    const trimmed = email.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key) || (!allowSelf && key === self)) return;
    seen.add(key);
    recipients.push(trimmed);
  };
  // The sender stays even when it's our own address — replying to a message
  // you sent yourself should still address it to that thread.
  add(msg.fromEmail || addressToEmail(msg.from), { allowSelf: true });
  if (all) {
    addressListToEmails(msg.to).forEach((email) => add(email));
    addressListToEmails(msg.cc).forEach((email) => add(email));
  }
  return recipients;
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

// Lazy gap between the "From:", "Sent:", "To:" and "Subject:" quote-header labels.
const QUOTE_HEADER_GAP = String.raw`[\s\S]{0,300}?`;
// Generic "From: ... Sent: ... To: ... Subject:" quote header, optionally preceded by tags/bold markup.
const GENERIC_QUOTE_HEADERS_RE = new RegExp(
  String.raw`(?:<[^>]*>\s*)*(?:<(?:b|strong)>)?\s*From\s*:\s*(?:<\/(?:b|strong)>)?${QUOTE_HEADER_GAP}\bSent\s*:${QUOTE_HEADER_GAP}\bTo\s*:${QUOTE_HEADER_GAP}\bSubject\s*:`,
  'i',
);

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
  const genericQuoteHeaders = content.search(GENERIC_QUOTE_HEADERS_RE);
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

function ThreadMessageContent({ threadMsg }: Readonly<{ threadMsg: EmailMessage }>) {
  const { t } = useI18n();
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = parseMainContent(threadMsg.bodyHtml, threadMsg.bodyText);
  const isHtml = !!threadMsg.bodyHtml;

  let mainContent: React.ReactNode;
  if (main) {
    mainContent = isHtml ? <IsolatedHtmlContent html={main} /> : <div className="whitespace-pre-wrap">{main}</div>;
  } else if (threadMsg.bodyText) {
    mainContent = <div className="whitespace-pre-wrap">{threadMsg.bodyText}</div>;
  } else {
    mainContent = <div className="text-gray-400 italic">{t.mail.messageDetail.noContent}</div>;
  }

  return (
    <div className="px-3 md:px-4 pb-4 pt-0 overflow-x-auto group/email">
      <div className="text-sm text-foreground leading-relaxed">
        {mainContent}
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

function ScheduledBanner({ messageId, scheduledFor, accountId, folder }: Readonly<{
  messageId: string;
  scheduledFor: string | Date;
  accountId: string;
  folder: string;
}>) {
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

const RECIPIENT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899'];

// "jane.doe@example.com" -> "Jane Doe"
function emailToDisplayName(email: string): string {
  return email.split('@')[0].split('.').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// The api-worker mail list / thread routes resolve sender avatars from the
// shared `contacts` table and project them onto `from.avatarUrl` for every
// message, so we just read them off the message object — no extra fetch.
function getSenderAvatarUrl(m: { from?: unknown }): string | undefined {
  if (typeof m.from === 'object' && m.from !== null) {
    const url = (m.from as { avatarUrl?: string | null }).avatarUrl;
    return url ?? undefined;
  }
  return undefined;
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

function readActiveFormats(): Record<string, boolean> {
  return {
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    insertUnorderedList: document.queryCommandState('insertUnorderedList'),
    insertOrderedList: document.queryCommandState('insertOrderedList'),
  };
}

function isSendShortcut(e: React.KeyboardEvent): boolean {
  return !(e.nativeEvent.isComposing || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey);
}

// `name` is the label as stored on the message (system labels are upper-case).
// Sent, Drafts and Scheduled are not offered: mail gets those by being sent,
// never by hand.
const SYSTEM_LABEL_ITEMS = [
  { name: 'INBOX', Icon: Inbox, labelKey: 'labelInbox', activeClassName: 'bg-gray-100' },
  { name: 'STARRED', Icon: Star, labelKey: 'labelStarred', activeClassName: 'bg-gray-100' },
  { name: 'IMPORTANT', Icon: Flag, labelKey: 'labelImportant', activeClassName: 'bg-gray-100' },
  { name: 'ARCHIVE', Icon: Archive, labelKey: 'labelArchive', activeClassName: 'bg-gray-100' },
  { name: 'SPAM', Icon: AlertTriangle, labelKey: 'labelSpam', activeClassName: 'bg-gray-100' },
  { name: 'TRASH', Icon: Trash, labelKey: 'labelTrash', activeClassName: 'bg-gray-200' },
] as const;

function SystemLabelButton({ active, activeClassName, Icon, label, disabled, onClick }: Readonly<{
  active: boolean;
  activeClassName: string;
  Icon: LucideIcon;
  label: string;
  disabled: boolean;
  onClick: () => void;
}>) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
        active ? activeClassName : "hover:bg-gray-100"
      )}
    >
      <Icon className={cn("h-4 w-4 flex-shrink-0", active ? "text-gray-600" : "text-gray-500")} />
      <span className="flex-1 text-left">{label}</span>
      {active && <Check className="h-4 w-4 text-gray-900 flex-shrink-0" />}
    </Button>
  );
}

/** A label the user made, as opposed to a system folder's row in the label list. */
// The folder list a message view returns to: the unified view's own list, or
// the account's.
function mailListPath(isUnified: boolean, accountId: string, folder: string): string {
  return isUnified ? `/weldmail/unified/${folder}` : `/weldmail/${accountId}/${folder}`;
}

function isUserLabel(label: MailTypes.Label & { isSystem?: boolean | null }): boolean {
  return !label.isSystem && !isSystemLabel(label.name.toLowerCase());
}

function LabelsPopoverContent({ messageLabels, availableLabels, isUpdatingLabels, onToggleLabel }: Readonly<{
  messageLabels: string[];
  availableLabels: MailTypes.Label[];
  isUpdatingLabels: boolean;
  onToggleLabel: (labelName: string) => void;
}>) {
  const { t } = useI18n();
  // The label list also carries a row per system folder; those are offered
  // once, above.
  const customLabels = availableLabels.filter((label) => isUserLabel(label));
  return (
    <>
      {/* System Labels */}
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 px-2">{t.mail.messageDetail.systemLabels}</div>
      <div className="space-y-0.5 mb-3">
        {SYSTEM_LABEL_ITEMS.map(({ name, Icon, labelKey, activeClassName }) => (
          <SystemLabelButton
            key={name}
            active={messageLabels.includes(name)}
            activeClassName={activeClassName}
            Icon={Icon}
            label={t.mail.messageDetail[labelKey]}
            disabled={isUpdatingLabels}
            onClick={() => onToggleLabel(name)}
          />
        ))}
      </div>

      {/* User Labels */}
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 px-2">{t.mail.messageDetail.customLabels}</div>
      {customLabels.length === 0 ? (
        <div className="text-sm text-gray-400 py-2 px-2">
          {t.mail.messageDetail.noCustomLabels}
        </div>
      ) : (
        <div className="space-y-0.5">
          {customLabels.map((label) => {
            const isApplied = messageLabels.includes(label.name);
            const color = getLabelColor(label.name, label);
            return (
              <Button
                variant="ghost"
                key={label.name}
                onClick={() => onToggleLabel(label.name)}
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
    </>
  );
}

function LabelBadge({ labelName, color, onRemove }: Readonly<{
  labelName: string;
  color: string;
  onRemove: (labelName: string) => void;
}>) {
  return (
    <span
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
        onClick={(e) => { e.stopPropagation(); onRemove(labelName); }}
        className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded-full bg-background border border-border shadow-sm hover:bg-muted transition-opacity"
      >
        <X className="h-2.5 w-2.5 text-muted-foreground" />
      </Button>
    </span>
  );
}

function LabelBadges({ messageLabels, availableLabels, onRemove }: Readonly<{
  messageLabels: string[];
  availableLabels: MailTypes.Label[];
  onRemove: (labelName: string) => void;
}>) {
  const renderBadge = (labelName: string) => {
    const labelData = availableLabels.find((l) => l.name === labelName);
    return (
      <LabelBadge
        key={labelName}
        labelName={labelName}
        color={getLabelColor(labelName, labelData)}
        onRemove={onRemove}
      />
    );
  };

  return (
    <div className="hidden md:flex gap-1.5 ml-2">
      {messageLabels.slice(0, 8).map((label) => renderBadge(label))}
      {messageLabels.length > 8 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted rounded transition-colors">
              +{messageLabels.length - 8}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <div className="flex flex-col gap-1.5">
              {messageLabels.slice(8).map((label) => renderBadge(label))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

// Removes every `<...>` run (leftmost, up to the first `>`), in a single linear pass.
function stripHtmlTags(html: string): string {
  let result = '';
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf('<', pos);
    if (open === -1) break;
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    result += html.slice(pos, open);
    pos = close + 1;
  }
  return result + html.slice(pos);
}

function draftPreviewText(html: string | undefined): string | undefined {
  return html ? stripHtmlTags(html).substring(0, 150) : undefined;
}

function DraftReplyCard({ draft, className, deleteButtonClassName, onOpen, onDelete }: Readonly<{
  draft: ThreadDraft;
  className: string;
  deleteButtonClassName: string;
  onOpen: () => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div
      role="button"
      tabIndex={0}
      className={className}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
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
              onDelete();
            }}
            className={deleteButtonClassName}
            title={t.mail.messageDetail.deleteDraft}
          >
            <Trash className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>
      {(draft.body || draft.htmlBody) && (
        <div className="px-3 md:px-4 pb-3 pt-0">
          <div className="text-sm text-muted-foreground truncate">
            {draftPreviewText(draft.body) || draftPreviewText(draft.htmlBody)}
          </div>
        </div>
      )}
    </div>
  );
}

function SenderAvatar({ avatarUrl, sender, fallbackChar, fallbackClassName }: Readonly<{
  avatarUrl: string | undefined;
  sender: string;
  fallbackChar: string;
  fallbackClassName: string;
}>) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={extractName(sender)}
        className="w-6 h-6 rounded-md object-cover flex-shrink-0"
      />
    );
  }
  return (
    <div
      className={fallbackClassName}
      style={{ backgroundColor: getAvatarColor(sender) }}
    >
      {(sender || fallbackChar).charAt(0).toUpperCase()}
    </div>
  );
}

/** Content-based React keys that stay unique when two items share the same base key. */
function uniqueKeys(baseKeys: string[]): string[] {
  const seen = new Map<string, number>();
  return baseKeys.map((base) => {
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}#${occurrence}`;
  });
}

function RecipientsPopover({ allRecipients, open, onOpenChange, onSelect }: Readonly<{
  allRecipients: { email: string; type: 'To' | 'Cc' }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (email: string, name: string) => void;
}>) {
  const { t } = useI18n();
  const recipientKeys = uniqueKeys(allRecipients.map((r) => `${r.type}:${r.email}`));
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="link" className="h-auto p-0 text-sm text-blue-600">
          +{allRecipients.length - 1}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="px-3 py-2 border-b">
          <p className="text-xs font-medium text-gray-500">{t.mail.messageDetail.recipients.replace('{n}', String(allRecipients.length))}</p>
        </div>
        <div className="p-2 space-y-1">
          {allRecipients.map((recipient, index) => {
            const name = emailToDisplayName(recipient.email);
            const initials = name.split(' ').map((n: string) => n[0]).join('').substring(0, 2);
            return (
              <Button
                variant="ghost"
                key={recipientKeys[index]}
                onClick={() => onSelect(recipient.email, name)}
                className="flex items-center gap-3 w-full text-left hover:bg-gray-100 px-2 py-1.5 rounded-md"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="text-xs text-white" style={{ backgroundColor: RECIPIENT_COLORS[index % RECIPIENT_COLORS.length] }}>
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
  );
}

function MessageBodyContent({ mainContent, isHtml, bodyHtml, bodyText }: Readonly<{
  mainContent: string;
  isHtml: boolean;
  bodyHtml?: string;
  bodyText?: string;
}>) {
  const { t } = useI18n();
  if (mainContent) {
    return isHtml ? (
      <IsolatedHtmlContent html={mainContent} />
    ) : (
      <div className="whitespace-pre-wrap">{mainContent}</div>
    );
  }
  if (bodyHtml) return <IsolatedHtmlContent html={bodyHtml} />;
  if (bodyText) return <div className="whitespace-pre-wrap">{bodyText}</div>;
  return <div className="text-gray-400 italic">{t.mail.messageDetail.noContent}</div>;
}

function QuotedContent({ quotedContent, isHtml, showQuoted, onToggle }: Readonly<{
  quotedContent: string;
  isHtml: boolean;
  showQuoted: boolean;
  onToggle: () => void;
}>) {
  const { t } = useI18n();
  return (
    <>
      <Button
        variant="ghost"
        type="button"
        onClick={onToggle}
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
  );
}

function AttachmentsSection({ hasLoadedAttachments, otherAttachments }: Readonly<{
  hasLoadedAttachments: boolean;
  otherAttachments: { id: string; fileName: string; size: number }[];
}>) {
  const { t } = useI18n();
  const download = (att: { id: string; fileName: string }) => {
    saveMailAttachment(att.id, att.fileName).catch(() =>
      toast.error(t.mail.messageDetail.failedToDownloadAttachment),
    );
  };
  return (
    <div className="mt-4 md:mt-6 space-y-2">
      {hasLoadedAttachments ? (
        otherAttachments.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <Paperclip className="h-3.5 w-3.5" />
              <span>{otherAttachments.length !== 1 ? t.mail.messageDetail.attachmentCountPlural.replace('{n}', String(otherAttachments.length)) : t.mail.messageDetail.attachmentCount.replace('{n}', String(otherAttachments.length))}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {otherAttachments.map((att) => (
                <button
                  type="button"
                  key={att.id}
                  onClick={() => download(att)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-border bg-white dark:bg-card hover:bg-gray-50 dark:hover:bg-secondary transition-colors text-sm group"
                >
                  <FileDown className="h-4 w-4 text-gray-400 group-hover:text-gray-600" />
                  <span className="text-gray-700 truncate max-w-[200px]">{att.fileName}</span>
                  <span className="text-gray-400 text-xs whitespace-nowrap">
                    {formatAttachmentSize(att.size)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        <div className="text-sm text-gray-400">{t.mail.messageDetail.loadingAttachments}</div>
      )}
    </div>
  );
}

function ThreadMessageCard({
  threadMsg,
  isExpanded,
  canReplyAll,
  onToggle,
  onOpenContact,
  onReply,
  onReplyAll,
}: Readonly<{
  threadMsg: EmailMessage;
  isExpanded: boolean;
  canReplyAll: boolean;
  onToggle: () => void;
  onOpenContact: (email: string, name: string) => void;
  onReply: () => void;
  onReplyAll: () => void;
}>) {
  const { t } = useI18n();
  const isSentMessage = threadMsg.folder?.toLowerCase() === 'sent';
  return (
    <div className="group relative border border-border/50 rounded-lg bg-muted/50">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
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
              const email = threadMsg.fromEmail || extractEmail(fromDisplayString(threadMsg.from));
              onOpenContact(email, extractName(fromDisplayString(threadMsg.from)));
            }}
            className="flex items-center gap-2 min-w-0 rounded-md focus:outline-none group/sender"
            title={t.mail.messageDetail.viewContactDetails}
          >
            <SenderAvatar
              avatarUrl={getSenderAvatarUrl(threadMsg)}
              sender={fromDisplayString(threadMsg.from)}
              fallbackChar="U"
              fallbackClassName="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs font-medium flex-shrink-0"
            />
            <span className="text-sm font-medium text-foreground truncate group-hover/sender:underline">
              {fromDisplayString(threadMsg.from)}
            </span>
          </Button>
          {isSentMessage && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-pink-100 text-pink-700 hover:bg-pink-100 flex-shrink-0">{t.mail.messageDetail.sentBadge}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="hidden md:inline text-xs text-muted-foreground">{format(new Date(threadMsg.date ?? 0), 'MMM d, yyyy h:mm a')}</span>
          <span className="md:hidden text-xs text-muted-foreground">{format(new Date(threadMsg.date ?? 0), 'MMM d')}</span>
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
            onReply();
          }}
          className="p-1.5 bg-white dark:bg-card border border-border rounded-md hover:bg-muted transition-colors"
          title={t.mail.compose.reply}
        >
          <Reply className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        {canReplyAll && (
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onReplyAll();
            }}
            className="p-1.5 bg-white dark:bg-card border border-border rounded-md hover:bg-muted transition-colors"
            title={t.mail.compose.replyAll}
          >
            <ReplyAll className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
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
  );
}

function FormatButton({ active, title, command, Icon, onCommand }: Readonly<{
  active: boolean | undefined;
  title: string;
  command: string;
  Icon: LucideIcon;
  onCommand: (command: string, value?: string) => void;
}>) {
  return (
    <Button variant="ghost" size="icon" className={cn("p-2 rounded-md transition-colors", active ? "bg-muted" : "hover:bg-muted")} title={title} onMouseDown={(e) => { e.preventDefault(); onCommand(command); }}>
      <Icon className={cn("h-4 w-4", active ? "text-foreground" : "text-muted-foreground")} />
    </Button>
  );
}

function ComposeToolbar({ activeFormats, onCommand, onFilesSelected, onOpenAi }: Readonly<{
  activeFormats: Record<string, boolean>;
  onCommand: (command: string, value?: string) => void;
  onFilesSelected: (files: File[]) => void;
  onOpenAi: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5">
      <FormatButton active={activeFormats.bold} title={t.mail.toolbar.bold} command="bold" Icon={Bold} onCommand={onCommand} />
      <FormatButton active={activeFormats.italic} title={t.mail.toolbar.italic} command="italic" Icon={Italic} onCommand={onCommand} />
      <FormatButton active={activeFormats.underline} title={t.mail.toolbar.underline} command="underline" Icon={Underline} onCommand={onCommand} />
      <div className="w-px h-5 bg-border mx-0.5" />
      <FormatButton active={activeFormats.insertUnorderedList} title={t.mail.toolbar.bulletList} command="insertUnorderedList" Icon={List} onCommand={onCommand} />
      <FormatButton active={activeFormats.insertOrderedList} title={t.mail.toolbar.numberedList} command="insertOrderedList" Icon={ListOrdered} onCommand={onCommand} />
      <div className="w-px h-5 bg-border mx-0.5" />
      <ComposeAttachButton
        title={t.mail.toolbar.attachFile}
        testId="reply-attach-input"
        className="p-2 hover:bg-muted rounded-md transition-colors"
        iconClassName="text-muted-foreground"
        onFilesSelected={onFilesSelected}
      />
      <Button variant="ghost" size="icon" className="p-2 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.insertLink} onMouseDown={(e) => {
        e.preventDefault();
        const url = prompt('Enter URL:');
        if (url) onCommand('createLink', url);
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
          onOpenAi();
        }}
      >
        <img src="/assets/images/weldagent/logo-light.png" alt="WeldAgent" className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ComposeToRow({ to, autoFocus, onToChange, onMinimize, onExpand }: Readonly<{
  to: string;
  autoFocus: boolean;
  onToChange: (value: string) => void;
  onMinimize: () => void;
  onExpand: () => void;
}>) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    // Focus only when the row mounts, matching the previous autoFocus behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <span className="text-xs text-muted-foreground font-medium">{t.mail.messageDetail.toPrefix}</span>
      <input
        ref={inputRef}
        type="text"
        className="flex-1 text-sm outline-none bg-transparent min-w-0 text-foreground"
        value={to}
        onChange={(e) => onToChange(e.target.value)}
      />
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className="p-1.5 hover:bg-muted rounded-md transition-colors"
          title={t.mail.messageDetail.minimizeToPanel}
          onClick={onMinimize}
        >
          <PictureInPicture2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className="p-1.5 hover:bg-muted rounded-md transition-colors"
          title={t.mail.messageDetail.expandToFullScreen}
          onClick={onExpand}
        >
          <Maximize className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The forwarded message's own files, shown in the forward box so the sender
 * sees what goes along and can leave some out.
 */
function ForwardedAttachmentChips({ attachments, onRemove }: Readonly<{
  attachments: { id: string; fileName: string }[];
  onRemove: (id: string) => void;
}>) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs max-w-[180px]"
        >
          <Paperclip className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{att.fileName}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-muted-foreground/20"
            onClick={() => onRemove(att.id)}
            title={t.mail.messageDetail.removeAttachment}
            aria-label={t.mail.messageDetail.removeAttachment}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function AttachedFileChips({ files, onRemove }: Readonly<{
  files: File[];
  onRemove: (index: number) => void;
}>) {
  const { t } = useI18n();
  const fileKeys = uniqueKeys(files.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
      {files.map((file, index) => (
        <div
          key={fileKeys[index]}
          className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs max-w-[180px]"
        >
          <span className="truncate">{file.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-muted-foreground/20"
            onClick={() => onRemove(index)}
            title={t.mail.messageDetail.cancel}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function InlineAiBar({
  isAgentInline,
  inputRef,
  prompt,
  placeholder,
  isGenerating,
  onPromptChange,
  onEnter,
  onCreate,
  onEscape,
  onCancel,
  onInsert,
}: Readonly<{
  isAgentInline: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  placeholder: string;
  isGenerating: boolean;
  onPromptChange: (value: string) => void;
  onEnter: () => void;
  onCreate: () => void;
  onEscape: () => void;
  onCancel: () => void;
  onInsert: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div className={cn("flex items-center gap-2 px-3 py-3", isAgentInline && "border-t border-border/50")}>
      <PenLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <textarea
        ref={inputRef}
        value={prompt}
        onChange={(e) => {
          onPromptChange(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            onEnter();
          }
          if (e.key === 'Escape') onEscape();
        }}
        placeholder={placeholder}
        className="flex-1 text-sm outline-none bg-transparent placeholder-muted-foreground/60 resize-none overflow-hidden min-h-[24px] mt-[3px] ml-[3px]"
        rows={1}
      />
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t.mail.messageDetail.cancelButton}
        </Button>
        {prompt.trim() ? (
          <Button
            size="sm"
            onClick={onCreate}
            disabled={isGenerating}
          >
            {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : t.mail.messageDetail.createButton}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onInsert}
          >
            {t.mail.messageDetail.insertButton}
          </Button>
        )}
      </div>
    </div>
  );
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

export function MessageDetail({ message, thread = [], accountId, folder, availableLabels = [], onLabelsChange, threadId, drafts = [] }: Readonly<MessageDetailProps>) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const archiveThreadMutation = useArchiveThread();
  const toggleStarMutation = useToggleMailStar();
  const pinThreadMutation = usePinThread();
  const trashThreadMutation = useTrashThread();
  const markThreadAsSpamMutation = useMarkThreadAsSpam();
  const deleteDraftMutation = useDeleteMailDraft();
  const generateAutoDraftMutation = useGenerateAutoDraft();
  const generateAIReplyMutation = useGenerateAIReply();
  const handleAiCreditsError = useAiCreditsToast();
  const { getClient } = useAppApiClient();
  const [isReplying, setIsReplying] = useState(false);
  const [isReplyingAll, setIsReplyingAll] = useState(false);
  const [isForwarding, setIsForwarding] = useState(false);
  // Forward the original as an .eml file instead of quoting it.
  const [forwardAsAttachment, setForwardAsAttachment] = useState(false);
  // Original attachments the sender removed from the forward.
  const [excludedForwardAttachmentIds, setExcludedForwardAttachmentIds] = useState<string[]>([]);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [composeData, setComposeData] = useState({ to: '', subject: '', body: '' });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
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
  const [inlineAiPrompt, setInlineAiPrompt] = useState('');
  const [isInlineAiGenerating, setIsInlineAiGenerating] = useState(false);
  const inlineAiInputRef = useRef<HTMLTextAreaElement>(null);

  // Customer panel context
  const customerPanel = useCustomerPanel();

  // Compose context for floating panel
  const composeContext = useComposeSafe();
  const threadList = useMailThreadListSafe();

  // Close the detail pane and stay in the current mailbox (unified or
  // per-account). Never jump to the conversation's own account inbox —
  // that would yank the user out of the unified view.
  const isUnifiedView = threadList?.isUnified ?? pathname.startsWith('/weldmail/unified/');
  const listPath = mailListPath(isUnifiedView, accountId, folder);
  const handleBackToList = () => {
    router.push(listPath);
  };

  // Track active formatting in the editor
  useEffect(() => {
    const updateFormats = () => {
      setActiveFormats(readActiveFormats());
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
              .filter((l) => !l.isSystem && !isSystemLabel(l.name.toLowerCase()))
              .map((l) => ({ id: l.id ?? '', name: l.name, color: l.color }))
          );
        }
      } catch {
        // Silently fail - labels just won't be available
      }
    };
    void fetchLabels();
  }, [accountId]);

  // Star and pin are server state: the STARRED / PINNED system labels (the
  // star also has its `isStarred` column). The override only bridges the
  // moment between the click and the refetch.
  const serverStarred = Boolean(message.isStarred) || (message.labels ?? []).includes('STARRED');
  const serverPinned = [message, ...thread].some((m) => (m.labels ?? []).includes('PINNED'));
  const [starOverride, setStarOverride] = useState<boolean | null>(null);
  const [pinOverride, setPinOverride] = useState<boolean | null>(null);
  useEffect(() => setStarOverride(null), [message.id, serverStarred]);
  useEffect(() => setPinOverride(null), [message.id, serverPinned]);
  const isStarred = starOverride ?? serverStarred;
  const isPinned = pinOverride ?? serverPinned;

  const handleTogglePin = () => {
    const next = !isPinned;
    setPinOverride(next);
    const onError = () => {
      setPinOverride(null);
      toast.error(t.mail.messageDetail.failedToUpdateLabels);
    };
    const onSuccess = () =>
      toast.success(next ? t.mail.messageDetail.emailPinned : t.mail.messageDetail.emailUnpinned);
    if (threadId) {
      pinThreadMutation.mutate({ accountId, threadId, on: next }, { onSuccess, onError });
      return;
    }
    const request = next
      ? mailApi.messages.addLabel(accountId, message.id, 'PINNED')
      : mailApi.messages.removeLabel(accountId, message.id, 'PINNED');
    request.then((result) => (result.success ? onSuccess() : onError())).catch(onError);
  };

  // Compute the newest message (shown at top) and older messages (shown in thread)
  const { newestMessage, olderMessages } = useMemo(() => {
    const allMessages = [message, ...localThread];
    allMessages.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
    return {
      newestMessage: allMessages[0],
      olderMessages: allMessages.slice(1),
    };
  }, [message, localThread]);

  // Our own address on this mailbox — excluded from reply-all recipients.
  const { data: accountsData } = useMailAccounts();
  const accountEmail = useMemo(
    () => (accountsData?.data ?? []).find((a) => a.id === accountId)?.email,
    [accountsData, accountId],
  );

  // "Reply all" only earns its place when there is somebody else to include.
  const replyAllRecipients = useMemo(
    () => (newestMessage ? buildReplyRecipients(newestMessage, { all: true, selfEmail: accountEmail }) : []),
    [newestMessage, accountEmail],
  );
  const canReplyAll = replyAllRecipients.length > 1;

  // Fetch attachments for the newest message
  const { data: attachmentsData } = useMailAttachments(
    newestMessage?.id || '',
    !!newestMessage?.hasAttachments,
  );
  const attachments = attachmentsData?.data || [];

  // The files of the message being forwarded; they go along unless removed.
  const { data: forwardAttachmentsData } = useMailAttachments(
    message.id,
    isForwarding && !!message.hasAttachments,
  );
  const forwardedAttachments = (forwardAttachmentsData?.data ?? []).filter(
    (att) => !att.isInline && !excludedForwardAttachmentIds.includes(att.id),
  );

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
    const ics = attachments.filter((att) => isIcsAttachment(att));
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
        const allRecipients = action === 'replyAll';
        setIsReplying(true);
        setIsReplyingAll(allRecipients);
        setIsForwarding(false);
        setReplyToMessageId(newestMessage.id);
        const to = buildReplyRecipients(newestMessage, { all: allRecipients, selfEmail: accountEmail }).join(', ');
        setComposeData({ to, subject: `Re: ${message.subject}`, body: '' });
      } else if (action === 'forward' || action === 'forwardAttachment') {
        setIsForwarding(true);
        setForwardAsAttachment(action === 'forwardAttachment');
        setExcludedForwardAttachmentIds([]);
        setIsReplying(false);
        setIsReplyingAll(false);
        setReplyToMessageId(newestMessage.id);
        setComposeData({ to: '', subject: `Fwd: ${message.subject}`, body: '' });
      }
    };
    window.addEventListener('mail:action', handleMailAction);
    return () => window.removeEventListener('mail:action', handleMailAction);
  }, [message.id, message.subject, newestMessage, accountEmail]);

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
      fromEmail: addressToEmail(newestMessage.to?.[0]),
      to: [to],
      cc: [],
      bcc: [],
      bodyText: body,
      // Prefer the exact HTML that was sent to the server so the optimistic
      // render matches the reloaded (server) version. Falling back to a naive
      // newline->`<br>` conversion loses whitespace/line breaks, which is why
      // sent replies briefly appeared with their spacing collapsed until reload.
      bodyHtml: html || body.replaceAll('\n', '<br>'),
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

  const resetCompose = () => {
    setIsReplying(false);
    setIsReplyingAll(false);
    setIsForwarding(false);
    setForwardAsAttachment(false);
    setExcludedForwardAttachmentIds([]);
    setReplyToMessageId(null);
    setComposeData({ to: '', subject: '', body: '' });
    setAttachedFiles([]);
    if (editorRef.current) editorRef.current.innerHTML = '';
  };

  const uploadAttachedFiles = async (textContent: string, htmlContent: string) => {
    if (emailSizeExceedsLimit(textContent, htmlContent, attachedFiles)) {
      toast.error(t.mail.composePage.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
      return null;
    }
    if (attachedFiles.length === 0) return [];
    try {
      const client = await getClient();
      return await uploadMailAttachments(client, accountId, attachedFiles);
    } catch (err) {
      const filename = err instanceof MailAttachmentUploadError ? err.filename : 'file';
      toast.error(t.mail.composePage.failedToUpload.replace('{filename}', filename));
      return null;
    }
  };

  const handleSendReply = async () => {
    if (isSending) return;
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    if (!textContent.trim()) {
      toast.error(t.mail.composePage.enterMessage);
      return;
    }
    setIsSending(true);
    try {
      const attachments = await uploadAttachedFiles(textContent, htmlContent);
      if (attachments === null) return;
      const result = await mailApi.messages.reply(accountId, message.id, {
        body: textContent,
        htmlBody: htmlContent,
        replyAll: isReplyingAll,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      if (result.success) {
        toast.success(t.mail.messageDetail.replySent);
        addOptimisticMessage(textContent, composeData.to, htmlContent);
        resetCompose();
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
    if (isSending) return;
    const toAddresses = composeData.to.split(/[,;]/).map((e: string) => e.trim()).filter((e: string) => e.length > 0);
    if (toAddresses.length === 0) {
      toast.error(t.mail.composePage.atLeastOneRecipient);
      return;
    }
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    setIsSending(true);
    try {
      const attachments = await uploadAttachedFiles(textContent, htmlContent);
      if (attachments === null) return;
      const result = await mailApi.messages.forward(accountId, message.id, {
        to: toAddresses,
        body: textContent || undefined,
        htmlBody: htmlContent || undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        excludeAttachmentIds:
          excludedForwardAttachmentIds.length > 0 ? excludedForwardAttachmentIds : undefined,
        asAttachment: forwardAsAttachment || undefined,
        // The quoted "Date:" line is written in the sender's own time.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: navigator.language,
      });
      if (result.success) {
        toast.success(t.mail.messageDetail.emailForwarded);
        addOptimisticMessage(textContent || `Forwarded: ${message.subject}`, composeData.to, htmlContent || undefined);
        resetCompose();
      } else {
        toast.error(result.error || t.mail.messageDetail.failedToForwardEmail);
      }
    } catch {
      toast.error(t.mail.messageDetail.failedToForwardEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleToggleStar = () => {
    const next = !isStarred;
    setStarOverride(next);
    toggleStarMutation.mutate(
      { id: message.id, isStarred: next },
      {
        onSuccess: () =>
          toast.success(next ? t.mail.messageDetail.starAdded : t.mail.messageDetail.starRemoved),
        onError: () => {
          setStarOverride(null);
          toast.error(t.mail.messageDetail.failedToUpdateLabels);
        },
      },
    );
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

  const handleArchive = async (): Promise<boolean> => {
    if (threadId) {
      try {
        const result = await archiveThreadMutation.mutateAsync({ accountId, threadId });
        toast.success(t.mail.messageDetail.archivedMessages.replace('{n}', String(result.archivedCount ?? 1)));
        window.dispatchEvent(new Event('mail:refresh'));
        return true;
      } catch {
        toast.error(t.mail.messageDetail.failedToArchive);
        return false;
      }
    }
    // Gmail-style: Remove INBOX, add ARCHIVE (system labels are uppercase)
    try {
      const hasInbox = messageLabels.some((l) => l.toLowerCase() === 'inbox');
      if (hasInbox) {
        await mailApi.messages.removeLabel(accountId, message.id, 'INBOX');
      }
      await mailApi.messages.addLabel(accountId, message.id, 'ARCHIVE');
      const newLabels = messageLabels
        .filter((l) => l.toLowerCase() !== 'inbox')
        .concat(messageLabels.some((l) => l.toLowerCase() === 'archive') ? [] : ['ARCHIVE']);
      setMessageLabels(newLabels);
      onLabelsChange?.(newLabels);
      toast.success(t.mail.messageDetail.archivedSingle);
      window.dispatchEvent(new Event('mail:refresh'));
      return true;
    } catch {
      toast.error(t.mail.messageDetail.failedToArchiveSingle);
      return false;
    }
  };

  // Drop the row from the left list immediately, then open the next
  // conversation. The archive request runs in the background; a failed
  // mutation puts the row back. Last item falls back to closing the pane.
  const handleArchiveAndNext = async () => {
    const current = { messageId: message.id, threadId };
    const list = threadList;
    const nextHref = list ? getNextThreadHref(list.threads, current, list) : null;
    const shouldHide = !!list && folderHidesOnArchive(list.folder);
    if (shouldHide) list?.hideThread(current);
    if (nextHref) router.push(nextHref);
    else handleBackToList();
    const archived = await handleArchive();
    if (!archived && shouldHide) list?.unhideThread(current);
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
          const newLabels = result.data?.labels ?? messageLabels.filter((l) => l !== labelName);
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
          // A location label (Inbox, Archive, Spam, Trash) replaces the
          // previous one, so the server's array is the truth.
          const newLabels = result.data?.labels ?? [...messageLabels, labelName];
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
    ...addressListToEmails(newestMessage.to).map((email) => ({ email, type: 'To' as const })),
    ...addressListToEmails(newestMessage.cc).map((email) => ({ email, type: 'Cc' as const })),
  ];
  const primaryToEmail = addressToEmail(newestMessage.to[0]);

  // Get the RFC messageId for the message being replied to (for inReplyTo header)
  const getReplyToRfcMessageId = (): string | undefined => {
    if (!replyToMessageId) return undefined;
    const allMsgs = [message, ...localThread];
    const target = allMsgs.find(m => m.id === replyToMessageId);
    return target?.messageId || undefined;
  };

  const cancelCompose = () => {
    setIsReplying(false);
    setIsReplyingAll(false);
    setIsForwarding(false);
    setReplyToMessageId(null);
    setComposeData({ to: '', subject: '', body: '' });
    setAttachedFiles([]);
    setIsAutoDraft(false);
    setInlineAiPrompt('');
    if (editorRef.current) editorRef.current.innerHTML = '';
  };

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const closeInlineAi = () => {
    setIsAutoDraft(false);
    setIsAgentInline(false);
    setInlineAiPrompt('');
  };

  const openInlineAi = () => {
    setIsAutoDraft(true);
    setIsAgentInline(true);
    setInlineAiPrompt('');
    setTimeout(() => inlineAiInputRef.current?.focus(), 0);
  };

  const insertInlineAi = () => {
    setIsAutoDraft(false);
    setInlineAiPrompt('');
  };

  const generateInlineAiReply = (getSuccessMessage: (editor: HTMLDivElement) => string, failureMessage: string) => {
    if (!inlineAiPrompt.trim() || isInlineAiGenerating) return;
    setIsInlineAiGenerating(true);
    generateAIReplyMutation.mutateAsync({ userPrompt: inlineAiPrompt, messageId: replyToMessageId || undefined, accountId })
      .then((result) => {
        const editor = editorRef.current;
        if (result.success && result.body && editor) {
          editor.innerHTML = formatAiBody(result.body);
          setIsAgentInline(false);
          toast.success(getSuccessMessage(editor));
        } else {
          toast.error(failureMessage);
        }
      })
      .catch((err) => {
        if (!handleAiCreditsError(err)) toast.error(failureMessage);
      })
      .finally(() => {
        setIsInlineAiGenerating(false);
        setInlineAiPrompt('');
      });
  };

  const handleEnterInlineAi = () => generateInlineAiReply(
    () => t.mail.messageDetail.draftUpdated,
    t.mail.messageDetail.failedToUpdateDraft,
  );

  const handleCreateInlineAi = () => generateInlineAiReply(
    (editor) => (editor.textContent?.trim() ? t.mail.messageDetail.draftUpdated : t.mail.messageDetail.aiContentGenerated),
    t.mail.messageDetail.failedToGenerateContent,
  );

  const minimizeComposeToPanel = () => {
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    composeContext?.openCompose({
      to: composeData.to,
      subject: composeData.subject || message.subject,
      body: htmlContent || textContent,
      inReplyTo: isReplying ? getReplyToRfcMessageId() : undefined,
      accountId,
      attachedFiles,
    }, currentMailHref());
    cancelCompose();
  };

  const expandComposeToFullScreen = () => {
    const htmlContent = editorRef.current?.innerHTML || '';
    const textContent = editorRef.current?.textContent || '';
    const rfcMessageId = isReplying ? getReplyToRfcMessageId() : undefined;
    if (composeContext) {
      composeContext.setPreviousUrl(currentMailHref());
      composeContext.updateComposeData({
        to: composeData.to,
        subject: composeData.subject || message.subject,
        body: htmlContent || textContent,
        inReplyTo: rfcMessageId,
        attachedFiles,
      });
    }
    cancelCompose();
    // Pass inReplyTo and returnUrl via URL params for reliability
    const params = new URLSearchParams();
    if (rfcMessageId) {
      params.set('inReplyTo', rfcMessageId);
    }
    params.set('returnUrl', currentMailHref());
    const qs = params.toString();
    const query = qs ? `?${qs}` : '';
    router.push(`/weldmail/${accountId}/${folder}/compose${query}`);
  };

  const renderComposeBox = (inThread = false) => {
    const isReply = isReplying;
    const placeholder = isReply ? t.mail.messageDetail.replyPlaceholder : t.mail.messageDetail.forwardMessagePlaceholder;
    const onSend = isReply ? handleSendReply : handleSendForward;
    const sendDisabled = isSending;

    if (!isReplying && !isForwarding) return null;

    const execCommand = (command: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      setActiveFormats(readActiveFormats());
    };

    return (
      <div
        role="presentation"
        className={cn("rounded-lg border border-border bg-white dark:bg-card mb-3 mt-4", !inThread && "mx-3 md:mx-4")}
        onKeyDown={(e) => {
          if (!isSendShortcut(e)) return;
          e.preventDefault();
          if (!sendDisabled) void onSend();
        }}
      >
        {/* To field */}
        <ComposeToRow
          to={composeData.to}
          autoFocus={!isReply}
          onToChange={(value) => setComposeData(prev => ({ ...prev, to: value }))}
          onMinimize={minimizeComposeToPanel}
          onExpand={expandComposeToFullScreen}
        />
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
        {isForwarding && forwardAsAttachment && (
          <div className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t.mail.messageDetail.forwardedAsAttachmentNote}</span>
          </div>
        )}
        {isForwarding && !forwardAsAttachment && forwardedAttachments.length > 0 && (
          <ForwardedAttachmentChips
            attachments={forwardedAttachments}
            onRemove={(id) => setExcludedForwardAttachmentIds((prev) => [...prev, id])}
          />
        )}
        {attachedFiles.length > 0 && (
          <AttachedFileChips
            files={attachedFiles}
            onRemove={removeAttachedFile}
          />
        )}
        {/* Actions bar */}
        {isAutoDraft ? (
          <InlineAiBar
            isAgentInline={isAgentInline}
            inputRef={inlineAiInputRef}
            prompt={inlineAiPrompt}
            placeholder={editorRef.current?.textContent?.trim() ? t.mail.messageDetail.aiEditPlaceholder : t.mail.messageDetail.aiReplyPlaceholder}
            isGenerating={isInlineAiGenerating}
            onPromptChange={setInlineAiPrompt}
            onEnter={handleEnterInlineAi}
            onCreate={handleCreateInlineAi}
            onEscape={closeInlineAi}
            onCancel={isAgentInline ? closeInlineAi : cancelCompose}
            onInsert={insertInlineAi}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 border-t border-border/50">
            <ComposeToolbar
              activeFormats={activeFormats}
              onCommand={execCommand}
              onFilesSelected={(files) => setAttachedFiles((prev) => [...prev, ...files])}
              onOpenAi={openInlineAi}
            />
            <div className="flex items-center gap-1.5 ml-auto">
              <Button variant="outline" size="sm" onClick={cancelCompose}>
                {t.mail.messageDetail.cancelButton}
              </Button>
              <Button size="sm" onClick={onSend} disabled={sendDisabled} title="Ctrl+Enter">
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : t.mail.compose.send}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const openDraft = (draft: ThreadDraft) => {
    router.push(`/weldmail/${accountId}/${folder}/compose?draftId=${draft.id}&returnUrl=${encodeURIComponent(currentMailHref())}`);
  };

  const deleteDraft = (draftId: string) => {
    deleteDraftMutation.mutate(draftId, {
      onSuccess: () => {
        toast.success(t.mail.messageDetail.draftDeleted);
      },
      onError: () => {
        toast.error(t.mail.messageDetail.failedToDeleteDraft);
      },
    });
  };

  const applyUserLabel = (labelName: string) => {
    void mailApi.messages.update(accountId, message.id, {
      labels: [...(message.labels || []), labelName],
    }).then((result) => {
      if (result.success) {
        toast.success(t.mail.messageDetail.labelAddedNamed.replace('{label}', labelName));
      } else {
        toast.error(t.mail.messageDetail.failedToUpdateLabels);
      }
    });
  };

  const applyAutoDraft = (draft: { subject?: string; body?: string }) => {
    const wasAlreadyReplying = isReplying && replyToMessageId === newestMessage.id;
    setIsReplying(true);
    setIsReplyingAll(false);
    setIsForwarding(false);
    setReplyToMessageId(newestMessage.id);
    setComposeData({
      to: newestMessage.fromEmail || addressToEmail(newestMessage.from),
      subject: draft.subject || `Re: ${message.subject}`,
      body: draft.body || '',
    });
    setIsAutoDraft(true);
    setIsAgentInline(false);
    setInlineAiPrompt('');
    // If compose box was already open, update editor immediately
    if (wasAlreadyReplying && editorRef.current) {
      editorRef.current.innerHTML = formatAiBody(draft.body || '');
      inlineAiInputRef.current?.focus();
    } else {
      // Wait for compose box to mount
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.innerHTML = formatAiBody(draft.body || '');
        }
        inlineAiInputRef.current?.focus();
      }, 150);
    }
  };

  const handleAutoDraft = async () => {
    setIsAutoGenerating(true);
    try {
      const result = await generateAutoDraftMutation.mutateAsync({ messageId: newestMessage.id, accountId });
      if (result.success && result.draft) {
        applyAutoDraft(result.draft);
        toast.success(t.mail.messageDetail.draftUpdated);
      } else {
        toast.error(t.mail.messageDetail.failedToUpdateDraft);
      }
    } catch (err) {
      if (!handleAiCreditsError(err)) toast.error(t.mail.messageDetail.failedToUpdateDraft);
    } finally {
      setIsAutoGenerating(false);
    }
  };

  const handleReplyToggle = () => {
    const wasReplying = isReplying && !isReplyingAll && replyToMessageId === newestMessage.id;
    setIsReplying(!wasReplying);
    setIsReplyingAll(false);
    setIsForwarding(false);
    setReplyToMessageId(!wasReplying ? newestMessage.id : null);
    if (!wasReplying) {
      setComposeData({
        to: buildReplyRecipients(newestMessage, { all: false, selfEmail: accountEmail }).join(', '),
        subject: `Re: ${message.subject}`,
        body: '',
      });
    }
  };

  const handleReplyAllToggle = () => {
    const wasReplyingAll = isReplying && isReplyingAll && replyToMessageId === newestMessage.id;
    setIsReplying(!wasReplyingAll);
    setIsReplyingAll(!wasReplyingAll);
    setIsForwarding(false);
    setReplyToMessageId(!wasReplyingAll ? newestMessage.id : null);
    if (!wasReplyingAll) {
      setComposeData({ to: replyAllRecipients.join(', '), subject: `Re: ${message.subject}`, body: '' });
    }
  };

  const handleForwardToggle = () => {
    const wasForwarding = isForwarding && replyToMessageId === newestMessage.id;
    setIsForwarding(!wasForwarding);
    setForwardAsAttachment(false);
    setExcludedForwardAttachmentIds([]);
    setIsReplying(false);
    setIsReplyingAll(false);
    setReplyToMessageId(!wasForwarding ? newestMessage.id : null);
    if (!wasForwarding) {
      setComposeData({ to: '', subject: `Fwd: ${message.subject}`, body: '' });
    }
  };

  const startThreadReply = (threadMsg: EmailMessage, replyAll: boolean) => {
    setIsReplying(true);
    setIsReplyingAll(replyAll);
    setIsForwarding(false);
    setReplyToMessageId(threadMsg.id);
    setComposeData({
      to: buildReplyRecipients(threadMsg, { all: replyAll, selfEmail: accountEmail }).join(', '),
      subject: `Re: ${threadMsg.subject || message.subject}`,
      body: '',
    });
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
          <div className="hidden md:flex h-7 items-center border border-border rounded-md overflow-hidden">
            <Button variant="ghost" size="icon-sm" className="h-full w-7 p-1 hover:bg-gray-100 dark:hover:bg-secondary transition-colors" onClick={() => window.history.back()}>
              <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
            </Button>
            <div className="w-px h-4 bg-border" />
            <Button variant="ghost" size="icon-sm" className="h-full w-7 p-1 hover:bg-gray-100 dark:hover:bg-secondary transition-colors" onClick={handleArchiveAndNext}>
              <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
            </Button>
          </div>
          <h1 className="text-sm md:text-lg font-semibold text-gray-900 dark:text-foreground md:ml-2 truncate">{message.subject}</h1>
          {/* Label badges - hidden on mobile */}
          {messageLabels.length > 0 && (
            <LabelBadges messageLabels={messageLabels} availableLabels={availableLabels} onRemove={handleToggleLabel} />
          )}
        </div>
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {/* Essential actions visible on mobile */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggleStar}
            className={cn("md:size-7 p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", isStarred && "text-yellow-500")}
          >
            <Star className={cn("h-4 w-4", isStarred ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
          </Button>
          {/* Pin button - hidden on mobile */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleTogglePin}
            className={cn("hidden md:flex md:size-7 p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", isPinned && "text-blue-500")}
            title={isPinned ? t.mail.messageDetail.unpin : t.mail.messageDetail.pin}
          >
            <Pin className={cn("h-4 w-4", isPinned ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleArchive}
            className="md:size-7 p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
            title={threadId ? t.mail.messageDetail.archiveConversation : t.mail.messageDetail.archivedSingle}
          >
            <Archive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          </Button>
          {/* Snooze button - hidden on mobile */}
          <Button variant="ghost" size="icon" className="hidden md:flex md:size-7 p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors" onClick={() => toast.success(t.mail.messageDetail.snoozeComingSoon)}>
            <Clock className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          </Button>
          {/* Labels popover - hidden on mobile */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="hidden md:flex h-7 p-1.5 has-[>svg]:px-1.5 hover:bg-gray-100 dark:hover:bg-secondary data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-secondary rounded-md transition-colors items-center gap-1 text-gray-500 dark:text-muted-foreground">
                <Tag className="h-4 w-4" />
                {messageLabels.length > 0 && (
                  <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
                    {messageLabels.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" align="end">
              <LabelsPopoverContent
                messageLabels={messageLabels}
                availableLabels={availableLabels}
                isUpdatingLabels={isUpdatingLabels}
                onToggleLabel={handleToggleLabel}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            className="md:size-7 p-1.5 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md transition-colors group/delete"
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

      {/* Scrollable Content Area.
          Person panels open via ObjectPanelHost (flex sibling of ModuleContent),
          so no right-margin reservation is needed here. */}
      <div className="flex-1 overflow-y-auto">
        {/* Reply/Forward compose - above newest message */}
        {(isReplying || isForwarding) && replyToMessageId === newestMessage.id && renderComposeBox()}

        {/* Draft replies to the newest message - shown above it */}
        {drafts.filter(d => d.inReplyTo === newestMessage.messageId).map((draft) => (
          <DraftReplyCard
            key={draft.id}
            draft={draft}
            className="mx-3 md:mx-4 mb-3 group relative border border-orange-200 rounded-lg bg-orange-50/50 cursor-pointer hover:bg-orange-50 transition-colors"
            deleteButtonClassName="p-1 opacity-0 group-hover:opacity-100 hover:bg-orange-100 rounded-md transition-all"
            onOpen={() => openDraft(draft)}
            onDelete={() => deleteDraft(draft.id)}
          />
        ))}

        {/* Sender Header */}
        <div className="px-3 md:px-4 py-3 md:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <SenderAvatar
                avatarUrl={getSenderAvatarUrl(newestMessage)}
                sender={fromDisplayString(newestMessage.from)}
                fallbackChar="?"
                fallbackClassName="w-6 h-6 rounded-md flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <Button
                    variant="link"
                    onClick={() => customerPanel.openPanel(newestMessage.fromEmail || extractEmail(fromDisplayString(newestMessage.from)), extractName(fromDisplayString(newestMessage.from)))}
                    className="h-auto p-0 font-semibold text-gray-900 dark:text-foreground text-[14.5px] focus:outline-none max-w-full shrink min-w-0"
                  >
                    <span className="truncate">{extractName(fromDisplayString(newestMessage.from))}</span>
                  </Button>
                  <span className="text-[14.5px] text-gray-500 dark:text-muted-foreground">{t.mail.messageDetail.toWord}</span>
                  <Button
                    variant="link"
                    onClick={() => customerPanel.openPanel(primaryToEmail, emailToDisplayName(primaryToEmail))}
                    className="h-auto p-0 text-[14.5px] text-blue-600 focus:outline-none max-w-full shrink min-w-0"
                    title={primaryToEmail}
                  >
                    <span className="truncate">{primaryToEmail}</span>
                  </Button>
                  {allRecipients.length > 1 && (
                    <RecipientsPopover
                      allRecipients={allRecipients}
                      open={showAllRecipients}
                      onOpenChange={setShowAllRecipients}
                      onSelect={(email, name) => {
                        setShowAllRecipients(false);
                        customerPanel.openPanel(email, name);
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-gray-500 dark:text-muted-foreground flex-shrink-0">
              <span className="text-sm text-gray-700 dark:text-muted-foreground">{format(new Date(newestMessage.date ?? 0), 'd MMM, HH:mm')}</span>
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
                  <DropdownMenuItem onClick={() => { copyText(message.id || '', () => toast.success(t.mail.messageDetail.messageIdCopied)); }}>
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
                    downloads are unaffected; they go through
                    `/api/mail-attachments/:id/download` (see AttachmentsSection).
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
                            onClick={() => applyUserLabel(l.name)}
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
            <MessageBodyContent
              mainContent={mainContent}
              isHtml={isHtml}
              bodyHtml={newestMessage.bodyHtml}
              bodyText={newestMessage.bodyText}
            />
            {quotedContent && (
              <QuotedContent
                quotedContent={quotedContent}
                isHtml={isHtml}
                showQuoted={showQuoted}
                onToggle={() => setShowQuoted(!showQuoted)}
              />
            )}
          </div>

          {/* Calendar invites (.ics) — offer a one-click add to Weld Calendar */}
          {calendarInvites.length > 0 && (
            <div className="mt-4 md:mt-6 space-y-2">
              {calendarInvites.map((att) => (
                <CalendarInviteCard
                  key={att.id}
                  attachmentId={att.id}
                  fileName={att.fileName}
                  size={att.size}
                />
              ))}
            </div>
          )}

          {/* Attachments */}
          {newestMessage.hasAttachments && (
            <AttachmentsSection hasLoadedAttachments={attachments.length > 0} otherAttachments={otherAttachments} />
          )}

          {/* Reply, Forward, and Auto Draft Buttons */}
          <div className="flex items-center justify-end gap-2 mt-4 md:mt-6">
            <Button
              variant="ghost"
              onClick={handleAutoDraft}
              disabled={isAutoGenerating}
              className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isAutoGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <img src="/assets/images/weldagent/logo-light.png" alt="WeldAgent" className="h-4 w-4" />}
              <span className="text-sm">{t.mail.messageDetail.autoDraft}</span>
            </Button>
            <Button
              variant="ghost"
              onClick={handleReplyToggle}
              className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2"
            >
              <Reply className="h-4 w-4" />
              <span className="text-sm">{t.mail.compose.reply}</span>
            </Button>
            {canReplyAll && (
              <Button
                variant="ghost"
                onClick={handleReplyAllToggle}
                className="flex-1 md:flex-initial px-3 py-2 md:py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors flex items-center justify-center gap-2"
              >
                <ReplyAll className="h-4 w-4" />
                <span className="text-sm">{t.mail.compose.replyAll}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={handleForwardToggle}
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
              {olderMessages.map((threadMsg) => (
                <React.Fragment key={threadMsg.id}>
                  {/* Reply/Forward compose - above this thread message */}
                  {(isReplying || isForwarding) && replyToMessageId === threadMsg.id && renderComposeBox(true)}
                  {/* Draft replies to this thread message */}
                  {drafts.filter(d => d.inReplyTo === threadMsg.messageId).map((draft) => (
                    <DraftReplyCard
                      key={draft.id}
                      draft={draft}
                      className="group/draft relative border border-orange-200 rounded-lg bg-orange-50/50 cursor-pointer hover:bg-orange-50 transition-colors mb-2"
                      deleteButtonClassName="p-1 opacity-0 group-hover/draft:opacity-100 hover:bg-orange-100 rounded-md transition-all"
                      onOpen={() => openDraft(draft)}
                      onDelete={() => deleteDraft(draft.id)}
                    />
                  ))}
                  <ThreadMessageCard
                    threadMsg={threadMsg}
                    isExpanded={expandedThreadIds.has(threadMsg.id)}
                    canReplyAll={buildReplyRecipients(threadMsg, { all: true, selfEmail: accountEmail }).length > 1}
                    onToggle={() => toggleThreadExpanded(threadMsg.id)}
                    onOpenContact={(email, name) => customerPanel.openPanel(email, name)}
                    onReply={() => startThreadReply(threadMsg, false)}
                    onReplyAll={() => startThreadReply(threadMsg, true)}
                  />
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Customer Detail Panel - hidden on mobile */}
      <div className="hidden md:block">
        <CustomerDetailPanel
          email={customerPanel.email || newestMessage.fromEmail || extractEmail(fromDisplayString(newestMessage.from))}
          name={customerPanel.name || extractName(fromDisplayString(newestMessage.from))}
          customerId={customerPanel.customerId || undefined}
          isOpen={customerPanel.isOpen}
          onClose={() => customerPanel.closePanel()}
          onCompose={(email) => {
            customerPanel.closePanel();
            setIsReplying(true);
            setIsReplyingAll(false);
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
