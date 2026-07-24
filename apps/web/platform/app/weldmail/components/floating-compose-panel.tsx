
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  useCreateMailDraft,
  useGenerateAIReply,
  useGenerateEmailDraft,
} from '@/hooks/queries/use-mail-queries';
import {
  usePersonSearch,
  useRecentCorrespondents,
} from '@/hooks/queries/use-people-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useParams, useRouter } from '@/lib/router';
import {
  X,
  Paperclip,
  Loader2,
  Link,
  Smile,
  Maximize2,
  Minus,
  Search,
  Plus,
  CircleCheck,
  Trash2,
  ArrowUp,
} from 'lucide-react';
import { WeldAgentIcon } from '@/components/icons/weldagent-icon';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format, addDays } from 'date-fns';
import { useComposeSafe } from '@/contexts/compose-context';
import { useCallSafe } from '@/contexts/call-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { mailApi } from '../lib/api-client';
import { useI18n } from '@/lib/i18n/provider';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';

// Server-side mirror lives in apps/api-worker/src/routes/mail/accounts.ts.
const MAX_EMAIL_SIZE_BYTES = 5 * 1024 * 1024;

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#3b82f6', '#10b981',
  '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#f97316',
];
function generateColor(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function FloatingComposePanel() {
  const { t } = useI18n();
  const handleAiCreditsError = useAiCreditsToast();
  const router = useRouter();
  const params = useParams();
  const composeContext = useComposeSafe();
  const accountId = (params?.accountId as string) || composeContext?.composeData?.accountId;
  const callContext = useCallSafe();
  const isDialerOpen = callContext?.isDialerOpen;
  const setIsDialerOpen = callContext?.setIsDialerOpen;
  const mobileNav = useMobileNavOptional();
  const { getClient } = useAppApiClient();
  const createDraftMutation = useCreateMailDraft();
  const generateAIReplyMutation = useGenerateAIReply();
  const generateEmailDraftMutation = useGenerateEmailDraft();
  const agentRight = mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 12}px` : '12px';

  // Only one floating panel at a time: close the call dialer when compose opens
  useEffect(() => {
    if (composeContext?.isComposeOpen && isDialerOpen) {
      setIsDialerOpen?.(false);
    }
  }, [composeContext?.isComposeOpen, isDialerOpen, setIsDialerOpen]);
  const textareaRef = useRef<HTMLDivElement>(null);
  const bodyInitializedRef = useRef(false);

  const [isSending, setIsSending] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [ccRecipients, setCcRecipients] = useState('');
  const [bccRecipients, setBccRecipients] = useState('');
  const [fontSize, setFontSize] = useState('14');
  const [textAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [scheduledTime, setScheduledTime] = useState<Date | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);

  // Formatting states
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);

  // AI input states
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  // Person autocomplete
  const [showContactSuggestions, setShowContactSuggestions] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState('');
  const toInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Store selection for restoring after toolbar clicks
  const savedSelectionRef = useRef<Range | null>(null);

  const isSearching = showContactSuggestions && contactSearchQuery.trim().length > 0;
  const personSearchResult = usePersonSearch(contactSearchQuery, isSearching);
  const recentPersonsResult = useRecentCorrespondents(accountId, showContactSuggestions && !isSearching);

  // Map Person/PersonSummary → suggestion shape the dropdown expects
  const personSuggestions = useMemo(() => {
    const raw = isSearching
      ? (personSearchResult.data?.data ?? [])
      : (recentPersonsResult.data?.data ?? []);
    return raw.map((p) => ({
      id: p.id,
      name: ('displayName' in p ? p.displayName : null) || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '',
      email: p.email ?? '',
      avatarUrl: p.avatarUrl ?? null,
      color: generateColor(p.email ?? p.id),
    }));
  }, [isSearching, personSearchResult.data, recentPersonsResult.data]);

  const filteredContacts = personSuggestions;

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        toInputRef.current &&
        !toInputRef.current.contains(event.target as Node)
      ) {
        setShowContactSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Initialize body content only once when panel opens
  useEffect(() => {
    if (composeContext?.isComposeOpen && textareaRef.current && !bodyInitializedRef.current) {
      textareaRef.current.innerHTML = composeContext.composeData.body || '';
      bodyInitializedRef.current = true;
    }
    // Reset when panel closes
    if (!composeContext?.isComposeOpen) {
      bodyInitializedRef.current = false;
    }
  }, [composeContext?.isComposeOpen, composeContext?.composeData.body]);

  const saveSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      savedSelectionRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    if (selection && savedSelectionRef.current) {
      selection.removeAllRanges();
      selection.addRange(savedSelectionRef.current);
    }
  };

  // Check formatting state
  const checkFormatting = () => {
    saveSelection();
    setIsBold(document.queryCommandState('bold'));
    setIsItalic(document.queryCommandState('italic'));
    setIsUnderline(document.queryCommandState('underline'));
  };

  const focusEditor = () => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      restoreSelection();
    }
  };

  // Prevent toolbar buttons from stealing focus
  const preventFocusLoss = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const executeCommand = (command: string, value?: string) => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      restoreSelection();
      document.execCommand(command, false, value);
      saveSelection();
    }
  };

  const handleBold = () => { executeCommand('bold'); checkFormatting(); };
  const handleItalic = () => { executeCommand('italic'); checkFormatting(); };
  const handleUnderline = () => { executeCommand('underline'); checkFormatting(); };
  const handleBulletList = () => { executeCommand('insertUnorderedList'); checkFormatting(); };
  const handleNumberedList = () => { executeCommand('insertOrderedList'); checkFormatting(); };
  const handleLink = () => { const url = prompt('Enter URL:'); if (url) executeCommand('createLink', url); checkFormatting(); };
  const insertEmoji = (emoji: string) => { executeCommand('insertText', emoji); checkFormatting(); };

  const handleOpenAiInput = () => {
    setShowAiInput(true);
    setTimeout(() => aiInputRef.current?.focus(), 0);
  };

  const handleCloseAiInput = () => {
    setShowAiInput(false);
    setAiPrompt('');
  };

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;

    setIsAiGenerating(true);
    try {
      if (composeData.inReplyTo) {
        // For replies, use the reply endpoint (body only)
        const result = await generateAIReplyMutation.mutateAsync({ userPrompt: aiPrompt, messageId: composeData.inReplyTo, accountId: accountId || undefined });
        if (result.success && result.body) {
          if (textareaRef.current) {
            const html = formatAiBody(result.body);
            textareaRef.current.innerHTML = html;
            updateComposeData({ body: html });
          }
          toast.success(t.mail.floatingCompose.aiContentGenerated);
          handleCloseAiInput();
        } else {
          toast.error(t.mail.floatingCompose.failedToGenerateContent);
        }
      } else {
        // For new emails, use the draft endpoint (subject + body)
        const result = await generateEmailDraftMutation.mutateAsync({ prompt: aiPrompt });
        if (result.success && result.data) {
          if (result.data.subject) {
            updateComposeData({ subject: result.data.subject });
          }
          if (result.data.body && textareaRef.current) {
            const html = formatAiBody(result.data.body);
            textareaRef.current.innerHTML = html;
            updateComposeData({ body: html });
          }
          toast.success(t.mail.floatingCompose.aiContentGenerated);
          handleCloseAiInput();
        } else {
          toast.error(t.mail.floatingCompose.failedToGenerateContent);
        }
      }
    } catch (err) {
      if (!handleAiCreditsError(err)) {
        toast.error(t.mail.floatingCompose.failedToGenerateContent);
      }
    } finally {
      setIsAiGenerating(false);
    }
  };

  const [isExpanding, setIsExpanding] = useState(false);
  const prevIsComposeOpenRef = useRef(false);

  // Reset the expanding flag when compose re-opens (e.g., after minimizing from compose page)
  useEffect(() => {
    const isOpen = composeContext?.isComposeOpen ?? false;
    if (isOpen && !prevIsComposeOpenRef.current) {
      // Compose just opened (false → true transition), reset expanding flag
      setIsExpanding(false);
    }
    prevIsComposeOpenRef.current = isOpen;
  }, [composeContext?.isComposeOpen]);

  if (!composeContext || !composeContext.isComposeOpen || isExpanding) {
    return null;
  }

  const { composeData, updateComposeData, closeCompose } = composeContext;

  const handleSelectContact = (contact: { name: string; email: string }) => {
    // Replace the in-progress fragment (the text being searched) with the chosen
    // email rather than appending it — otherwise the typed query lingers and the
    // recipient ends up in the field twice (e.g. "joh, joh@example.com").
    const parts = composeData.to.split(',');
    parts[parts.length - 1] = contact.email;
    const newTo = parts.map(p => p.trim()).filter(Boolean).join(', ');
    updateComposeData({ to: newTo });
    setShowContactSuggestions(false);
    setContactSearchQuery('');
    toInputRef.current?.focus();
  };

  const handleToChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    updateComposeData({ to: value });
    const parts = value.split(',');
    const lastPart = parts[parts.length - 1].trim();
    setContactSearchQuery(lastPart);
    setShowContactSuggestions(lastPart.length > 0);
  };

  const handleExpand = () => {
    setIsExpanding(true);
    router.push(`/weldmail/${accountId}/inbox/compose`);
  };

  const handleClose = () => {
    closeCompose();
  };

  const handleSend = async () => {
    // Get body content directly from the ref (may not be synced to context yet)
    const bodyContent = textareaRef.current?.innerHTML || composeData.body || '';

    if (!composeData.to.trim()) {
      toast.error(t.mail.composePage.atLeastOneRecipient);
      return;
    }
    if (!accountId) {
      toast.error(t.mail.composePage.noAccountSelected);
      return;
    }
    if (!bodyContent.trim()) {
      toast.error(t.mail.composePage.enterMessage);
      return;
    }

    const parseRecipients = (str: string): string[] =>
      str.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);

    const toAddresses = parseRecipients(composeData.to);

    if (scheduledTime) {
      setIsSending(true);
      try {
        const client = await getClient();
        const ccAddresses = ccRecipients ? parseRecipients(ccRecipients) : undefined;
        const bccAddresses = bccRecipients ? parseRecipients(bccRecipients) : undefined;

        // Upload attachments to R2 and pass fileKeys (same pattern as immediate send).
        const trimmedBodyScheduled = bodyContent.trim();
        const htmlBodyScheduled = bodyContent.includes('<') ? bodyContent : bodyContent.replace(/\n/g, '<br>');
        const bodyBytesScheduled = new TextEncoder().encode(trimmedBodyScheduled).byteLength
          + new TextEncoder().encode(htmlBodyScheduled).byteLength;
        const attachmentBytesScheduled = attachedFiles.reduce((sum, f) => sum + f.size, 0);
        if (bodyBytesScheduled + attachmentBytesScheduled > MAX_EMAIL_SIZE_BYTES) {
          toast.error(t.mail.floatingCompose.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
          setIsSending(false);
          return;
        }

        const uploadedAttachments: Array<{
          filename: string;
          contentType: string;
          size: number;
          fileKey: string;
        }> = [];
        for (const file of attachedFiles) {
          try {
            const contentType = file.type || 'application/octet-stream';
            const genResp = await client.post<{
              success: boolean;
              uploadUrl: string;
              uploadToken: string;
              fileKey: string;
            }>('/storage/generate-upload-url', {
              fileName: file.name,
              contentType,
              fileSize: file.size,
              folder: 'mail-attachments',
              entityType: 'mail-attachment',
              entityId: accountId,
              isPublic: false,
            });
            const putResp = await fetch(genResp.uploadUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': contentType },
            });
            if (!putResp.ok) throw new Error(`Upload failed: ${putResp.status}`);
            uploadedAttachments.push({
              filename: file.name,
              contentType,
              size: file.size,
              fileKey: genResp.fileKey,
            });
          } catch {
            toast.error(t.mail.floatingCompose.failedToUpload.replace('{filename}', file.name));
            setIsSending(false);
            return;
          }
        }

        const result = await mailApi.scheduled.schedule({
          accountId,
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject: composeData.subject.trim() || t.mail.composePage.noSubject,
          body: trimmedBodyScheduled,
          htmlBody: htmlBodyScheduled,
          scheduledFor: scheduledTime,
          inReplyTo: composeData.inReplyTo || undefined,
          attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        });
        if (result.success) {
          toast.success(t.mail.floatingCompose.emailScheduledFor.replace('{date}', format(scheduledTime, 'PPp')));
          window.dispatchEvent(new Event('mail:refresh'));
          closeCompose();
        } else {
          toast.error(result.error || t.mail.floatingCompose.failedToScheduleEmail);
        }
      } catch {
        toast.error(t.mail.floatingCompose.failedToScheduleEmail);
      } finally {
        setIsSending(false);
      }
      return;
    }

    setIsSending(true);
    try {
      // Upload attachments to R2 first, then pass fileKeys to /send.
      const trimmedBody = bodyContent.trim();
      const htmlBody = bodyContent.includes('<') ? bodyContent : bodyContent.replace(/\n/g, '<br>');
      const bodyBytes = new TextEncoder().encode(trimmedBody).byteLength
        + new TextEncoder().encode(htmlBody).byteLength;
      const attachmentBytes = attachedFiles.reduce((sum, f) => sum + f.size, 0);
      if (bodyBytes + attachmentBytes > MAX_EMAIL_SIZE_BYTES) {
        toast.error(t.mail.floatingCompose.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
        setIsSending(false);
        return;
      }

      const uploadedAttachments: Array<{
        filename: string;
        contentType: string;
        size: number;
        fileKey: string;
      }> = [];
      if (attachedFiles.length > 0) {
        const client = await getClient();
        for (const file of attachedFiles) {
          try {
            const contentType = file.type || 'application/octet-stream';
            const genResp = await client.post<{
              success: boolean;
              uploadUrl: string;
              uploadToken: string;
              fileKey: string;
            }>('/storage/generate-upload-url', {
              fileName: file.name,
              contentType,
              fileSize: file.size,
              folder: 'mail-attachments',
              entityType: 'mail-attachment',
              entityId: accountId,
              isPublic: false,
            });
            const putResp = await fetch(genResp.uploadUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': contentType },
            });
            if (!putResp.ok) throw new Error(`Upload failed: ${putResp.status}`);
            uploadedAttachments.push({
              filename: file.name,
              contentType,
              size: file.size,
              fileKey: genResp.fileKey,
            });
          } catch {
            toast.error(t.mail.floatingCompose.failedToUpload.replace('{filename}', file.name));
            setIsSending(false);
            return;
          }
        }
      }

      const result = await mailApi.messages.send(accountId, {
        to: toAddresses,
        subject: composeData.subject.trim() || t.mail.composePage.noSubject,
        body: trimmedBody,
        htmlBody,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      });

      if (result.success) {
        toast.success(t.mail.floatingCompose.emailSentSuccessfully);
        window.dispatchEvent(new Event('mail:refresh'));
        closeCompose();
      } else {
        toast.error(result.error || t.mail.floatingCompose.failedToSendEmail);
      }
    } catch {
      toast.error(t.mail.floatingCompose.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleSaveDraft = async () => {
    try {
      const bodyContent = textareaRef.current?.innerHTML || composeData.body || '';
      const toAddresses = composeData.to ? composeData.to.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0) : [];
      const result = await createDraftMutation.mutateAsync({
        accountId,
        subject: composeData.subject || undefined,
        to: toAddresses.length > 0 ? toAddresses : undefined,
        cc: ccRecipients ? ccRecipients.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0) : undefined,
        bcc: bccRecipients ? bccRecipients.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0) : undefined,
        body: bodyContent || undefined,
        htmlBody: bodyContent.includes('<') ? bodyContent : undefined,
        inReplyTo: composeData.inReplyTo || undefined,
      });
      if (result.success) {
        toast.success(t.mail.floatingCompose.draftSaved);
      } else {
        toast.error(t.mail.floatingCompose.failedToSaveDraft);
      }
    } catch (error) {
      console.error('Failed to save draft:', error);
      toast.error(t.mail.floatingCompose.failedToSaveDraft);
    }
    handleClose();
  };

  const hasContent = composeData.to || composeData.subject || composeData.body || (textareaRef.current?.innerHTML && textareaRef.current.innerHTML.trim());

  if (isMinimized) {
    return (
      <div className="fixed bottom-3 z-50" style={{ right: agentRight }}>
        <div className="flex items-center gap-1 bg-background border border-border rounded-lg shadow-lg">
          <Button
            variant="ghost"
            onClick={() => setIsMinimized(false)}
            className="flex items-center gap-2 px-4 py-2.5 hover:bg-muted transition-colors rounded-l-lg"
          >
            <span className="text-sm font-medium text-foreground truncate max-w-[200px]">
              {composeData.subject || t.mail.compose.newMessage}
            </span>
          </Button>
          <div className="w-px h-5 bg-border" />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setIsMinimized(false);
              handleOpenAiInput();
            }}
            className="p-2.5 hover:bg-muted transition-colors"
            title={t.mail.floatingCompose.aiAssistant}
          >
            <WeldAgentIcon className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMinimized(false)}
            className="p-2.5 hover:bg-muted transition-colors"
            title={t.mail.floatingCompose.expand}
          >
            <Maximize2 className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setIsMinimized(false);
              handleClose();
            }}
            className="p-2.5 hover:bg-muted transition-colors rounded-r-lg"
            title={t.mail.floatingCompose.close}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-3 z-50 w-[560px] min-h-[450px] max-h-[80vh] bg-background rounded-xl border border-border shadow-[0_0_20px_rgba(0,0,0,0.06)] dark:shadow-[0_0_20px_rgba(0,0,0,0.3)] flex flex-col" style={{ right: agentRight }}>
      {/* Header - Same as compose page */}
      <div className="px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {hasContent ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="px-3">
                    {t.mail.floatingCompose.close}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      handleSaveDraft();
                    }}
                  >
                    <CircleCheck className="h-4 w-4 mr-0.5" />
                    {t.mail.floatingCompose.saveAndCloseDraft}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      handleClose();
                    }}
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                    {t.mail.floatingCompose.deleteDraft}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button onClick={handleClose} variant="outline" size="icon" className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            )}

            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setIsMinimized(true)}
              title={t.mail.floatingCompose.minimize}
            >
              <Minus className="h-4 w-4" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="px-3"
              onClick={handleExpand}
            >
              {t.mail.floatingCompose.expand}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {/* Scheduled Time Badge */}
            {scheduledTime && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400 rounded-lg text-sm">
                <span>{format(scheduledTime, 'MMM d, h:mm a')}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setScheduledTime(null)}
                  className="hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="px-3">
                  {t.mail.floatingCompose.schedule}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={scheduledTime || undefined}
                  onSelect={(date) => {
                    if (date) {
                      const hours = scheduledTime?.getHours() ?? 9;
                      const minutes = scheduledTime?.getMinutes() ?? 0;
                      date.setHours(hours, minutes, 0, 0);
                      setScheduledTime(date);
                    }
                  }}
                  disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0)) || date > addDays(new Date(), 7)}
                  initialFocus
                />
                <div className="border-t border-border px-3 py-3">
                  <div className="text-xs font-medium text-muted-foreground mb-2">{t.mail.floatingCompose.time}</div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={String(scheduledTime?.getHours() ?? 9)}
                      onValueChange={(value) => {
                        const hours = parseInt(value);
                        const newDate = scheduledTime ? new Date(scheduledTime) : new Date();
                        if (!scheduledTime) newDate.setDate(newDate.getDate() + 1);
                        newDate.setHours(hours, scheduledTime?.getMinutes() ?? 0, 0, 0);
                        setScheduledTime(newDate);
                      }}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {i.toString().padStart(2, '0')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-muted-foreground">:</span>
                    <Select
                      value={String(scheduledTime?.getMinutes() ?? 0)}
                      onValueChange={(value) => {
                        const minutes = parseInt(value);
                        const newDate = scheduledTime ? new Date(scheduledTime) : new Date();
                        if (!scheduledTime) newDate.setDate(newDate.getDate() + 1);
                        newDate.setHours(scheduledTime?.getHours() ?? 9, minutes, 0, 0);
                        setScheduledTime(newDate);
                      }}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 60 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {i.toString().padStart(2, '0')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Button type="button" onClick={handleSend} disabled={isSending} size="sm" className="!px-3">
              {isSending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {scheduledTime ? t.mail.floatingCompose.schedule : t.mail.compose.send}
            </Button>
          </div>
        </div>
      </div>

      {/* Compose Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-[300px]">
        <div className="bg-background flex-1 flex flex-col overflow-hidden">
          {/* Subject Field */}
          <div className="px-4 pt-4 pb-4">
            <input
              type="text"
              placeholder={t.mail.composePage.subjectPlaceholder}
              className="w-full text-xl font-semibold outline-none bg-transparent text-foreground placeholder-muted-foreground"
              value={composeData.subject}
              onChange={(e) => updateComposeData({ subject: e.target.value })}
            />
          </div>

          {/* To Field */}
          <div className="px-4 pb-4 relative">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 flex-1">
                <span className="text-sm text-muted-foreground">{t.mail.composePage.toPrefix}</span>
                <input
                  ref={toInputRef}
                  type="text"
                  className="flex-1 text-sm outline-none bg-transparent text-blue-600 dark:text-blue-400"
                  value={composeData.to}
                  onChange={handleToChange}
                  onFocus={() => {
                    if (composeData.to) {
                      const parts = composeData.to.split(',');
                      const lastPart = parts[parts.length - 1].trim();
                      if (lastPart) {
                        setContactSearchQuery(lastPart);
                        setShowContactSuggestions(true);
                      }
                    }
                  }}
                />
              </div>
              {!showCcBcc && (
                <Button
                  variant="ghost"
                  onClick={() => setShowCcBcc(true)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                >
                  {t.mail.floatingCompose.ccBcc}
                </Button>
              )}
            </div>

            {/* Contact Suggestions Dropdown — shadcn popover/command styling */}
            {showContactSuggestions && filteredContacts.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute left-0 top-full mt-1 w-full max-w-md bg-popover text-popover-foreground border rounded-md shadow-md z-50 overflow-hidden p-1"
              >
                {filteredContacts.map((contact) => (
                  <Button
                    variant="ghost"
                    key={contact.id}
                    onClick={() => handleSelectContact(contact)}
                    className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors text-left"
                  >
                    {contact.avatarUrl ? (
                      <img
                        src={contact.avatarUrl}
                        alt={contact.name}
                        className="h-6 w-6 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div
                        className="h-6 w-6 rounded-full flex items-center justify-center text-white text-[10px] font-medium flex-shrink-0"
                        style={{ backgroundColor: contact.color }}
                      >
                        {getInitials(contact.name)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{contact.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{contact.email}</div>
                    </div>
                  </Button>
                ))}
                <div className="-mx-1 my-1 h-px bg-border" />
                <Button
                  variant="ghost"
                  onClick={() => toast.info(t.mail.floatingCompose.searchInAddressListComingSoon)}
                  className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors text-left text-muted-foreground"
                >
                  <Search className="h-4 w-4" />
                  <span>{t.mail.floatingCompose.searchInAddressList}</span>
                </Button>
              </div>
            )}

            {showCcBcc && (
              <div className="space-y-2 mt-2">
                <input
                  type="text"
                  placeholder={t.mail.compose.cc}
                  className="w-full text-sm outline-none bg-transparent placeholder-muted-foreground text-blue-600 dark:text-blue-400"
                  value={ccRecipients}
                  onChange={(e) => setCcRecipients(e.target.value)}
                />
                <input
                  type="text"
                  placeholder={t.mail.compose.bcc}
                  className="w-full text-sm outline-none bg-transparent placeholder-muted-foreground text-blue-600 dark:text-blue-400"
                  value={bccRecipients}
                  onChange={(e) => setBccRecipients(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="mx-4 border-t border-border/60" />

          {/* Message Body */}
          <div className="flex-1 pt-4 pb-4 overflow-y-auto relative">
            {/* AI Generating Skeleton */}
            {isAiGenerating && (
              <div className="absolute inset-0 px-4 pt-4 pb-4 z-10">
                <div className="space-y-[10px] animate-pulse">
                  <div className="h-[10px] w-[90%] rounded bg-[#c4b0f0]/30" />
                  <div className="h-[10px] w-[75%] rounded bg-[#c4b0f0]/30" />
                  <div className="h-[10px] w-[55%] rounded bg-[#c4b0f0]/30" />
                  <div className="h-[10px]" />
                  <div className="h-[10px] w-[85%] rounded bg-[#c4b0f0]/30" />
                  <div className="h-[10px] w-[95%] rounded bg-[#c4b0f0]/30" />
                  <div className="h-[10px] w-[60%] rounded bg-[#c4b0f0]/30" />
                </div>
              </div>
            )}
            {/* Content Editable Area */}
            <div
              ref={textareaRef}
              contentEditable={!isAiGenerating}
              suppressContentEditableWarning
              data-placeholder={t.mail.floatingCompose.writePlaceholder}
              className={cn(
                "w-full min-h-[150px] px-4 text-sm outline-none bg-transparent text-foreground [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
                isAiGenerating && "opacity-0"
              )}
              onSelect={checkFormatting}
              onKeyUp={checkFormatting}
              onClick={checkFormatting}
              style={{
                fontSize: `${fontSize}px`,
                textAlign: textAlignment,
              }}
              onBlur={(e) => {
                updateComposeData({ body: e.currentTarget.innerHTML });
              }}
            />

            {/* Attached Files */}
            {attachedFiles.length > 0 && (
              <div className="mt-4 mx-4 p-4 bg-muted/50 rounded-lg border border-border">
                <div className="flex items-center gap-2 text-foreground mb-3">
                  <Paperclip className="h-3.5 w-3.5" />
                  <span className="text-sm font-medium">
                    {attachedFiles.length > 1 ? t.mail.floatingCompose.attachmentCountPlural.replace('{n}', String(attachedFiles.length)) : t.mail.floatingCompose.attachmentCount.replace('{n}', String(attachedFiles.length))}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {(attachedFiles.reduce((acc, file) => acc + file.size, 0) / 1024).toFixed(2)} KB
                  </span>
                </div>
                <div className="flex items-start gap-3 flex-wrap">
                  {attachedFiles.map((file, index) => {
                    const isImage = file.type.startsWith('image/');
                    const fileExtension = file.name.split('.').pop()?.toUpperCase() || 'FILE';
                    const fileName = file.name.split('.').slice(0, -1).join('.') || file.name;
                    return (
                      <div key={index} className="relative group">
                        <div className="w-20 h-20 bg-muted rounded-lg overflow-hidden flex items-center justify-center border border-border">
                          {isImage ? (
                            <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="text-muted-foreground text-xs font-medium">{fileExtension}</div>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== index))}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-muted hover:bg-muted-foreground/20 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3 text-foreground" />
                        </Button>
                        <div className="mt-1.5 max-w-20">
                          <div className="text-xs text-foreground truncate">{fileName}</div>
                          <div className="text-[10px] text-muted-foreground">{fileExtension}</div>
                        </div>
                      </div>
                    );
                  })}
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      multiple
                      onChange={(e) => {
                        if (e.target.files) {
                          setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                        }
                      }}
                    />
                    <div className="w-20 h-20 bg-muted hover:bg-muted-foreground/10 rounded-lg flex items-center justify-center transition-colors border border-border">
                      <Plus className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Toolbar */}
      <div className="border-t border-gray-200 dark:border-border flex-shrink-0 relative">
        {/* AI Draft Inline Bar */}
        {showAiInput && (
          <div className="absolute bottom-full left-0 right-0 flex items-center gap-1.5 border-t border-b border-gray-200 dark:border-border px-4 py-2 bg-background">
            <input
              ref={aiInputRef}
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && aiPrompt.trim()) {
                  e.preventDefault();
                  handleAiGenerate();
                }
                if (e.key === 'Escape') {
                  handleCloseAiInput();
                }
              }}
              placeholder={t.mail.floatingCompose.aiPlaceholder}
              className="flex-1 bg-transparent text-sm text-gray-900 dark:text-foreground placeholder:text-gray-400 dark:placeholder:text-muted-foreground outline-none"
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={() => {
                if (aiPrompt.trim()) {
                  handleAiGenerate();
                }
              }}
              disabled={!aiPrompt.trim() || isAiGenerating}
              className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30 transition-opacity"
            >
              {isAiGenerating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}
        {/* Regular Toolbar */}
        <div className="flex items-center gap-1 flex-wrap px-4 py-2">
            {/* Font Size */}
            <Select value={fontSize} onValueChange={(value) => { setFontSize(value); focusEditor(); }}>
              <SelectTrigger className="h-7 w-[56px] text-[13.5px] border-0 shadow-none hover:bg-muted px-2 rounded-md focus:ring-0 focus:ring-offset-0 focus:outline-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="12">12</SelectItem>
                <SelectItem value="14">14</SelectItem>
                <SelectItem value="16">16</SelectItem>
                <SelectItem value="18">18</SelectItem>
                <SelectItem value="20">20</SelectItem>
              </SelectContent>
            </Select>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Text Formatting */}
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBold} className={cn("p-1.5 hover:bg-muted rounded-md transition-colors", isBold && "bg-muted")} title={t.mail.toolbar.bold}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
              </svg>
            </Button>
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleItalic} className={cn("p-1.5 hover:bg-muted rounded-md transition-colors", isItalic && "bg-muted")} title={t.mail.toolbar.italic}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="19" y1="4" x2="10" y2="4" />
                <line x1="14" y1="20" x2="5" y2="20" />
                <line x1="15" y1="4" x2="9" y2="20" />
              </svg>
            </Button>
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleUnderline} className={cn("p-1.5 hover:bg-muted rounded-md transition-colors", isUnderline && "bg-muted")} title={t.mail.toolbar.underline}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
                <line x1="4" y1="21" x2="20" y2="21" />
              </svg>
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Lists */}
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBulletList} className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.bulletList}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <circle cx="4" cy="6" r="1" fill="currentColor" />
                <circle cx="4" cy="12" r="1" fill="currentColor" />
                <circle cx="4" cy="18" r="1" fill="currentColor" />
              </svg>
            </Button>
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleNumberedList} className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.numberedList}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="10" y1="6" x2="21" y2="6" />
                <line x1="10" y1="12" x2="21" y2="12" />
                <line x1="10" y1="18" x2="21" y2="18" />
                <path d="M4 6h1v4" />
                <path d="M4 10h2" />
                <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
              </svg>
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Link & Emoji */}
            <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleLink} className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.insertLink}>
              <Link className="h-4 w-4" />
            </Button>
            {/* Emoji picker - hidden on mobile */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} className="hidden md:block p-1.5 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.insertEmoji}>
                  <Smile className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="start" side="top">
                <div className="grid grid-cols-8 gap-1">
                  {['😀', '😂', '😊', '😍', '🥰', '😎', '🤔', '😢', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '❤️', '🔥', '✨', '⭐', '💯', '✅', '❌', '⚠️', '📧'].map((emoji) => (
                    <Button
                      variant="ghost"
                      size="icon"
                      key={emoji}
                      onMouseDown={preventFocusLoss}
                      onClick={() => insertEmoji(emoji)}
                      className="p-1.5 hover:bg-muted rounded text-lg"
                    >
                      {emoji}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Attachment */}
            <label className="cursor-pointer" onMouseDown={preventFocusLoss}>
              <input
                type="file"
                className="hidden"
                multiple
                onChange={(e) => {
                  if (e.target.files) {
                    setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                  }
                }}
              />
              <div className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t.mail.toolbar.attachFile}>
                <Paperclip className="h-4 w-4" />
              </div>
            </label>

            <div className="w-px h-5 bg-border mx-1" />

            {/* AI Assistant */}
            <Button
              variant="ghost"
              size="icon"
              onMouseDown={preventFocusLoss}
              onClick={() => !isAiGenerating && (showAiInput ? handleCloseAiInput() : handleOpenAiInput())}
              className={cn("p-1.5 hover:bg-muted rounded-md transition-colors", showAiInput && "bg-[#8d65ef]/10")}
              title={t.mail.toolbar.aiAssistant}
            >
              <WeldAgentIcon className={cn("h-4 w-4", showAiInput ? "text-[#8d65ef]" : "opacity-60 hover:opacity-100")} />
            </Button>
          </div>
      </div>
    </div>
  );
}
