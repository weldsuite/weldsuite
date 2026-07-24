
import { useState, useRef, useEffect, useMemo } from 'react';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import {
  X,
  ArrowUp,
  Paperclip,
  Loader2,
  Link,
  Smile,
  Plus,
  UserPlus,
  CircleCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
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
import { mailApi } from '../../../lib/api-client';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { MailDraftRow } from '@weldsuite/app-api-client/domains/mail-drafts';
import {
  usePersonSearch,
  useRecentCorrespondents,
  useCreatePerson,
} from '@/hooks/queries/use-people-queries';
import { useComposeSafe } from '@/contexts/compose-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface PersonSuggestion {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

// A complete, syntactically valid email address (used to decide whether Enter
// should commit the typed text verbatim or resolve the highlighted suggestion).
const isCompleteEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// Server-side mirror lives in apps/api-worker/src/routes/mail/accounts.ts.
const MAX_EMAIL_SIZE_BYTES = 5 * 1024 * 1024;

interface ComposePageProps {
  accountId?: string;
  labelSlug?: string;
  returnUrl?: string;
}

export default function ComposePage({ accountId: accountIdProp, labelSlug: labelSlugProp, returnUrl: returnUrlProp }: ComposePageProps = {}) {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const draftId = searchParams?.get('draftId') || null;
  const inReplyToParam = searchParams?.get('inReplyTo') || null;
  const returnUrlParam = returnUrlProp || searchParams?.get('returnUrl') || null;
  const { getClient } = useAppApiClient();
  const createPersonMutation = useCreatePerson();
  const accountId = accountIdProp || (params?.accountId as string);
  const labelSlug = labelSlugProp || (params?.labelSlug as string);
  const textareaRef = useRef<HTMLDivElement>(null);
  const composeContext = useComposeSafe();

  // Form state - initialize from compose context if available
  const hasContextData = !!(composeContext?.composeData.to || composeContext?.composeData.subject || composeContext?.composeData.body);
  const [toRecipients, setToRecipients] = useState<string[]>(() => {
    if (hasContextData && composeContext?.composeData.to) {
      return composeContext.composeData.to.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);
    }
    return [];
  });
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState(() => hasContextData ? composeContext?.composeData.subject || '' : '');
  const [body, setBody] = useState(() => hasContextData ? composeContext?.composeData.body || '' : '');

  const [isSending, setIsSending] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
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

  // AI Draft
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingAiDraft, setIsGeneratingAiDraft] = useState(false);
  const aiInputRef = useRef<HTMLInputElement>(null);

  const generateAiDraft = async (prompt: string) => {
    setIsGeneratingAiDraft(true);
    setAiPromptOpen(false);
    setAiPrompt('');
    try {
      const client = await getClient();
      const result = await client.post<{ success: boolean; data: { subject: string; body: string } }>(
        '/mail-ai/draft',
        { prompt, accountId: accountId || undefined, replyToMessageId: inReplyTo || undefined }
      );
      if (result.success && result.data) {
        if (result.data.subject && !subject) {
          setSubject(result.data.subject);
        }
        if (result.data.body) {
          const htmlBody = formatAiBody(result.data.body);
          setBody(htmlBody);
          if (textareaRef.current) {
            textareaRef.current.innerHTML = htmlBody;
          }
        }
        toast.success(t.mail.composePage.aiDraftGenerated);
      }
    } catch (err) {
      const status =
        (err as { status?: number; response?: { status?: number } } | undefined)?.status ||
        (err as { status?: number; response?: { status?: number } } | undefined)?.response?.status;
      if (status === 402) {
        toast.error(t.mail.composePage.insufficientAiCredits);
      } else {
        toast.error(t.mail.composePage.failedToGenerateDraft);
      }
    } finally {
      setIsGeneratingAiDraft(false);
    }
  };

  // Use URL params (most reliable) with compose context as fallback
  const returnUrl = useRef<string | null>(returnUrlParam || composeContext?.previousUrl || null);
  const [currentDraftId] = useState<string | null>(draftId);
  const [inReplyTo, setInReplyTo] = useState<string | undefined>(inReplyToParam || composeContext?.composeData.inReplyTo || undefined);

  // Sync from compose context if URL params were not provided
  useEffect(() => {
    if (!draftId && !inReplyToParam && composeContext?.composeData.inReplyTo && !inReplyTo) {
      setInReplyTo(composeContext.composeData.inReplyTo);
    }
    if (!returnUrlParam && composeContext?.previousUrl && !returnUrl.current) {
      returnUrl.current = composeContext.previousUrl;
    }
  }, [composeContext?.composeData.inReplyTo, composeContext?.previousUrl, draftId, inReplyTo, inReplyToParam, returnUrlParam]);

  // Load draft from API when draftId is provided
  const hasLoadedDraft = useRef(false);
  useEffect(() => {
    if (draftId && !hasLoadedDraft.current) {
      hasLoadedDraft.current = true;
      getClient().then((client) =>
        client.get<{ success: boolean; data: MailDraftRow }>(`/mail-drafts/${draftId}`)
      ).then((result) => {
        if (result.success && result.data) {
          const draft = result.data;
          if (draft.to && draft.to.length > 0) {
            setToRecipients(draft.to);
          }
          if (draft.subject) setSubject(draft.subject);
          if (draft.cc?.length) {
            setCcRecipients(draft.cc.join(', '));
            setShowCc(true);
          }
          if (draft.bcc?.length) {
            setBccRecipients(draft.bcc.join(', '));
            setShowBcc(true);
          }
          const draftBody = draft.htmlBody || draft.body || '';
          if (draftBody) {
            setBody(draftBody);
            if (textareaRef.current) {
              textareaRef.current.innerHTML = draftBody;
            }
          }
          if (draft.inReplyTo) {
            setInReplyTo(draft.inReplyTo);
          }
        }
      });
    }
  }, [draftId, getClient]);

  // Initialize editor with body from compose context
  const hasInitializedFromContext = useRef(false);
  useEffect(() => {
    if (!hasInitializedFromContext.current && !draftId && composeContext?.composeData.body && textareaRef.current) {
      textareaRef.current.innerHTML = composeContext.composeData.body;
      hasInitializedFromContext.current = true;
      // Close the floating panel if it's open (but not if we're minimizing)
      if (composeContext.isComposeOpen && !isMinimizingRef.current) {
        composeContext.closeCompose();
      }
    }
  }, [composeContext, draftId]);

  useEffect(() => {
    if (aiPromptOpen && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 50);
    }
  }, [aiPromptOpen]);

  // Person autocomplete
  const [showContactSuggestions, setShowContactSuggestions] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState('');
  const toInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const isSearching = showContactSuggestions && contactSearchQuery.trim().length > 0;
  const personSearchResult = usePersonSearch(contactSearchQuery, isSearching);
  const recentPersonsResult = useRecentCorrespondents(accountId, showContactSuggestions && !isSearching);
  const isLoadingContacts = isSearching ? personSearchResult.isLoading : recentPersonsResult.isLoading;

  const contacts: PersonSuggestion[] = useMemo(() => {
    const raw = isSearching
      ? (personSearchResult.data?.data ?? [])
      : (recentPersonsResult.data?.data ?? []);
    return raw.map((p) => ({
      id: p.id,
      name: ('displayName' in p ? p.displayName : null) || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '',
      email: p.email ?? '',
      avatarUrl: p.avatarUrl ?? null,
    }));
  }, [isSearching, personSearchResult.data, recentPersonsResult.data]);

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

  // Store selection for restoring after toolbar clicks
  const savedSelectionRef = useRef<Range | null>(null);

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
    // Focus the editor and restore selection before executing command
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

  const addRecipient = (email: string) => {
    const trimmed = email.trim();
    if (trimmed && !toRecipients.includes(trimmed)) {
      setToRecipients(prev => [...prev, trimmed]);
    }
    setToInput('');
    setContactSearchQuery('');
    setShowContactSuggestions(false);
    toInputRef.current?.focus();
  };

  const handleSelectContact = (contact: { name: string; email: string }) => {
    addRecipient(contact.email);
  };

  const handleToInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // If user types a comma or semicolon, confirm the current input
    if (value.endsWith(',') || value.endsWith(';')) {
      const email = value.slice(0, -1).trim();
      if (email) addRecipient(email);
      return;
    }
    setToInput(value);
    setContactSearchQuery(value.trim());
    setShowContactSuggestions(true);
  };

  const handleToInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      const trimmed = toInput.trim();
      // When the user has typed a partial name/email and a suggestion is shown,
      // Enter/Tab should resolve to the highlighted (first) contact's email —
      // not commit the raw typed text, which otherwise adds a bad chip and forces
      // the real address to be entered a second time. A fully-typed email is
      // respected verbatim.
      const firstSuggestion =
        showContactSuggestions && trimmed && !isCompleteEmail(trimmed)
          ? contacts.find((c) => c.email && !toRecipients.includes(c.email))
          : undefined;
      if (firstSuggestion) {
        e.preventDefault();
        addRecipient(firstSuggestion.email);
      } else if (trimmed) {
        e.preventDefault();
        addRecipient(trimmed);
      }
    } else if (e.key === 'Backspace' && !toInput && toRecipients.length > 0) {
      setToRecipients(prev => prev.slice(0, -1));
    }
  };

  const handleClose = () => {
    router.push(returnUrl.current || `/weldmail/${accountId}/${labelSlug}`);
  };

  const isMinimizingRef = useRef(false);

  const handleMinimize = () => {
    if (composeContext) {
      isMinimizingRef.current = true;

      // Get the current body content from the editor
      const currentBody = textareaRef.current?.innerHTML || body;

      // Transfer data to floating panel
      composeContext.minimizeToPanel({
        to: [...toRecipients, ...(toInput.trim() ? [toInput.trim()] : [])].join(', '),
        subject,
        body: currentBody,
        cc: ccRecipients,
        bcc: bccRecipients,
        attachedFiles,
        scheduledTime,
        accountId,
      });

      // Navigate back to where the user came from
      router.push(returnUrl.current || `/weldmail/${accountId}/${labelSlug}`);
    } else {
      // Fallback if context not available
      handleClose();
    }
  };

  const handleSend = async () => {
    // Commit any pending input
    const allRecipients = [...toRecipients];
    if (toInput.trim()) {
      allRecipients.push(toInput.trim());
    }
    if (allRecipients.length === 0) {
      toast.error(t.mail.composePage.atLeastOneRecipient);
      return;
    }
    if (!body.trim()) {
      toast.error(t.mail.composePage.enterMessage);
      return;
    }

    const parseRecipients = (str: string): string[] =>
      str.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);

    const toAddresses = allRecipients;

    if (scheduledTime) {
      setIsSending(true);
      try {
        const client = await getClient();
        const ccAddresses = ccRecipients ? parseRecipients(ccRecipients) : undefined;
        const bccAddresses = bccRecipients ? parseRecipients(bccRecipients) : undefined;

        // Upload attachments to R2 and pass fileKeys (same pattern as immediate send).
        const trimmedBodyScheduled = body.trim();
        const htmlBodyScheduled = body.includes('<') ? body : body.replace(/\n/g, '<br>');
        const bodyBytesScheduled = new TextEncoder().encode(trimmedBodyScheduled).byteLength
          + new TextEncoder().encode(htmlBodyScheduled).byteLength;
        const attachmentBytesScheduled = attachedFiles.reduce((sum, f) => sum + f.size, 0);
        if (bodyBytesScheduled + attachmentBytesScheduled > MAX_EMAIL_SIZE_BYTES) {
          toast.error(t.mail.composePage.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
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
            toast.error(t.mail.composePage.failedToUpload.replace('{filename}', file.name));
            setIsSending(false);
            return;
          }
        }

        const result = await mailApi.scheduled.schedule({
          accountId,
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject: subject.trim() || t.mail.composePage.noSubject,
          body: trimmedBodyScheduled,
          htmlBody: htmlBodyScheduled,
          scheduledFor: scheduledTime,
          attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        });
        if (result.success) {
          toast.success(t.mail.composePage.emailScheduledFor.replace('{date}', format(scheduledTime, 'PPp')));
          window.dispatchEvent(new Event('mail:refresh'));
          router.push(returnUrl.current || `/weldmail/${accountId}/sent`);
        } else {
          toast.error(result.error || t.mail.composePage.failedToScheduleEmail);
        }
      } catch {
        toast.error(t.mail.composePage.failedToScheduleEmail);
      } finally {
        setIsSending(false);
      }
      return;
    }

    setIsSending(true);
    try {
      // Upload attachments to R2 first, then pass fileKeys to /send.
      // Mirrors the 5 MiB server-side cap so the user gets instant feedback.
      const trimmedBody = body.trim();
      const htmlBody = body.includes('<') ? body : body.replace(/\n/g, '<br>');
      const bodyBytes = new TextEncoder().encode(trimmedBody).byteLength
        + new TextEncoder().encode(htmlBody).byteLength;
      const attachmentBytes = attachedFiles.reduce((sum, f) => sum + f.size, 0);
      if (bodyBytes + attachmentBytes > MAX_EMAIL_SIZE_BYTES) {
        toast.error(t.mail.composePage.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
        setIsSending(false);
        return;
      }

      const uploadedAttachments: Array<{
        filename: string;
        contentType: string;
        size: number;
        fileKey: string;
      }> = [];
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
          toast.error(t.mail.composePage.failedToUpload.replace('{filename}', file.name));
          setIsSending(false);
          return;
        }
      }

      const result = await mailApi.messages.send(accountId, {
        to: toAddresses,
        cc: ccRecipients ? parseRecipients(ccRecipients) : undefined,
        bcc: bccRecipients ? parseRecipients(bccRecipients) : undefined,
        subject: subject.trim() || t.mail.composePage.noSubject,
        body: trimmedBody,
        htmlBody,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      });

      if (result.success) {
        toast.success(t.mail.composePage.emailSentSuccessfully);
        window.dispatchEvent(new Event('mail:refresh'));
        router.push(returnUrl.current || `/weldmail/${accountId}/sent`);
      } else {
        const errorMsg = result.error || t.mail.composePage.failedToSendEmail;
        toast.error(errorMsg);
      }
    } catch {
      toast.error(t.mail.composePage.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleSaveDraft = async () => {
    try {
      const allTo = [...toRecipients, ...(toInput.trim() ? [toInput.trim()] : [])];
      const bodyContent = textareaRef.current?.innerHTML || body || '';
      const draftData = {
        subject: subject || undefined,
        to: allTo.length > 0 ? allTo : undefined,
        cc: ccRecipients ? ccRecipients.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0) : undefined,
        bcc: bccRecipients ? bccRecipients.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0) : undefined,
        body: bodyContent || undefined,
        htmlBody: bodyContent.includes('<') ? bodyContent : undefined,
        inReplyTo: inReplyTo || undefined,
      };
      const client = await getClient();
      let result;
      if (currentDraftId) {
        result = await client.put<{ success: boolean; error?: string }>(`/mail-drafts/${currentDraftId}`, draftData);
      } else {
        result = await client.post<{ success: boolean; error?: string }>('/mail-drafts', { accountId, ...draftData });
      }
      if (result.success) {
        toast.success(t.mail.composePage.draftSaved);
      } else {
        toast.error(result.error || t.mail.composePage.failedToSaveDraft);
      }
    } catch (error) {
      console.error('Failed to save draft:', error);
      toast.error(t.mail.composePage.failedToSaveDraft);
    }
    handleClose();
  };

  const handleDeleteDraft = async () => {
    try {
      if (currentDraftId) {
        const client = await getClient();
        await client.delete(`/mail-drafts/${currentDraftId}`);
        toast.success(t.mail.composePage.draftDeleted);
      }
    } catch (error) {
      console.error('Failed to delete draft:', error);
      toast.error(t.mail.composePage.failedToSaveDraft);
    }
    handleClose();
  };

  const hasContent = toRecipients.length > 0 || toInput || subject || body;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-background">
      {/* Header */}
      <div className="px-4 h-[53px] flex items-center border-b border-gray-200 dark:border-border flex-shrink-0">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {hasContent ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="px-3">
                    {t.mail.composePage.cancel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      handleSaveDraft();
                    }}
                  >
                    <CircleCheck className="h-4 w-4 mr-1.5" />
                    {t.mail.composePage.saveAndCloseDraft}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      handleDeleteDraft();
                    }}
                    className="text-red-600 focus:text-red-600 focus:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4 mr-1.5 text-red-600" />
                    {t.mail.composePage.deleteDraft}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button onClick={handleClose} variant="outline" size="sm" className="px-3">
                {t.mail.composePage.cancel}
              </Button>
            )}

            {/* Minimize button - hidden on mobile */}
            <Button
              variant="outline"
              size="sm"
              className="hidden md:inline-flex px-3"
              onClick={handleMinimize}
            >
              {t.mail.composePage.minimize}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {/* Scheduled Time Badge */}
            {scheduledTime && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm">
                <span>{format(scheduledTime, 'MMM d, h:mm a')}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setScheduledTime(null)}
                  className="hover:bg-blue-100 dark:hover:bg-accent rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button data-testid="compose-schedule-btn" variant="outline" size="sm" className="px-3">
                  {t.mail.composePage.schedule}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={scheduledTime || undefined}
                  onSelect={(date) => {
                    if (date) {
                      const now = new Date();
                      const isToday = date.toDateString() === now.toDateString();
                      if (isToday) {
                        date.setHours(now.getHours(), now.getMinutes() + 1, 0, 0);
                      } else {
                        const hours = scheduledTime?.getHours() ?? 9;
                        const minutes = scheduledTime?.getMinutes() ?? 0;
                        date.setHours(hours, minutes, 0, 0);
                      }
                      setScheduledTime(date);
                    }
                  }}
                  disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0)) || date > addDays(new Date(), 7)}
                  initialFocus
                />
                <div className="border-t border-gray-200 dark:border-border px-3 py-3">
                  <div className="text-xs font-medium text-gray-500 dark:text-muted-foreground mb-2">{t.mail.composePage.time}</div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={String(scheduledTime?.getHours() ?? new Date().getHours())}
                      onValueChange={(value) => {
                        const hours = parseInt(value);
                        const newDate = scheduledTime ? new Date(scheduledTime) : new Date();
                        const mins = scheduledTime?.getMinutes() ?? new Date().getMinutes();
                        newDate.setHours(hours, mins, 0, 0);
                        if (newDate < new Date()) {
                          newDate.setMinutes(new Date().getMinutes() + 1);
                        }
                        setScheduledTime(newDate);
                      }}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(() => {
                          const now = new Date();
                          const selectedDate = scheduledTime || now;
                          const isToday = selectedDate.toDateString() === now.toDateString();
                          const minHour = isToday ? now.getHours() : 0;
                          return Array.from({ length: 24 }, (_, i) => i)
                            .filter(i => i >= minHour)
                            .map(i => (
                              <SelectItem key={i} value={String(i)}>
                                {i.toString().padStart(2, '0')}
                              </SelectItem>
                            ));
                        })()}
                      </SelectContent>
                    </Select>
                    <span className="text-gray-500 dark:text-muted-foreground">:</span>
                    <Select
                      value={String(scheduledTime?.getMinutes() ?? Math.min(new Date().getMinutes() + 1, 59))}
                      onValueChange={(value) => {
                        const minutes = parseInt(value);
                        const newDate = scheduledTime ? new Date(scheduledTime) : new Date();
                        newDate.setHours(scheduledTime?.getHours() ?? new Date().getHours(), minutes, 0, 0);
                        setScheduledTime(newDate);
                      }}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(() => {
                          const now = new Date();
                          const selectedDate = scheduledTime || now;
                          const isToday = selectedDate.toDateString() === now.toDateString();
                          const selectedHour = scheduledTime?.getHours() ?? now.getHours();
                          const isSameHour = isToday && selectedHour === now.getHours();
                          const minMinute = isSameHour ? now.getMinutes() + 1 : 0;
                          return Array.from({ length: 60 }, (_, i) => i)
                            .filter(i => i >= minMinute)
                            .map(i => (
                              <SelectItem key={i} value={String(i)}>
                                {i.toString().padStart(2, '0')}
                              </SelectItem>
                            ));
                        })()}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Button type="button" data-testid="compose-send-btn" onClick={handleSend} disabled={isSending} size="sm" className="px-3">
              {isSending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {scheduledTime ? t.mail.composePage.schedule : t.mail.composePage.send}
            </Button>
          </div>
        </div>
      </div>

      {/* Compose Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden px-4">
          {/* Subject Field */}
          <div className="pt-6 pb-2">
            <input
              type="text"
              placeholder={t.mail.composePage.subjectPlaceholder}
              className="w-full text-[22px] font-semibold outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* To Field */}
          <div className="py-2 relative">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm text-gray-500 dark:text-muted-foreground">{t.mail.composePage.toPrefix}</span>
                <div
                  className="flex-1 flex flex-wrap items-center gap-1 min-w-0 min-h-[26px] cursor-text"
                  onClick={() => toInputRef.current?.focus()}
                >
                  {toRecipients.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 h-[26px] pl-2 pr-1 bg-gray-50 dark:bg-accent/40 text-gray-700 dark:text-foreground rounded-sm text-sm border border-gray-200 dark:border-border/50"
                    >
                      {email}
                      <button
                        type="button"
                        aria-label={t.mail.composePage.removeRecipient}
                        onClick={(e) => {
                          e.stopPropagation();
                          setToRecipients(prev => prev.filter(r => r !== email));
                          toInputRef.current?.focus();
                        }}
                        className="flex items-center justify-center rounded-sm p-0.5 text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-200 dark:hover:bg-accent transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    ref={toInputRef}
                    type="text"
                    className="flex-1 min-w-[120px] h-[26px] text-sm outline-none bg-transparent"
                    value={toInput}
                    onChange={handleToInputChange}
                    onKeyDown={handleToInputKeyDown}
                    onFocus={() => {
                      setContactSearchQuery(toInput.trim());
                      setShowContactSuggestions(true);
                    }}
                    onBlur={() => {
                      // Commit pending input on blur (with small delay for click events)
                      setTimeout(() => {
                        if (toInput.trim()) {
                          addRecipient(toInput);
                        }
                      }, 200);
                    }}
                    placeholder={toRecipients.length === 0 ? t.mail.composePage.addRecipients : ''}
                  />
                </div>
              </div>
              {(!showCc || !showBcc) && (
                <div className="flex items-center gap-0.5">
                  {!showCc && (
                    <Button
                      variant="ghost"
                      data-testid="compose-cc-toggle"
                      onClick={() => setShowCc(true)}
                      className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-md px-1.5 py-1 transition-colors"
                    >
                      {st('sweep.weldmail.compose.cc')}
                    </Button>
                  )}
                  {!showBcc && (
                    <Button
                      variant="ghost"
                      data-testid="compose-bcc-toggle"
                      onClick={() => setShowBcc(true)}
                      className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-md px-1.5 py-1 transition-colors"
                    >
                      {st('sweep.weldmail.compose.bcc')}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Contact Suggestions Dropdown — shadcn popover/command styling */}
            {showContactSuggestions && (
              <div
                ref={suggestionsRef}
                className="absolute left-0 top-full mt-1 w-full max-w-md bg-popover text-popover-foreground border rounded-md shadow-md z-50 overflow-hidden max-h-[250px] overflow-y-auto p-1"
              >
                {isLoadingContacts && contacts.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t.mail.composePage.loadingContacts}</span>
                  </div>
                ) : contacts.filter(c => !toRecipients.includes(c.email)).length > 0 ? (
                  contacts.filter(c => !toRecipients.includes(c.email)).map((contact) => (
                    <Button
                      variant="ghost"
                      key={contact.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSelectContact(contact)}
                      className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors text-left"
                    >
                      <Avatar className="h-7 w-7 !rounded-[9px] flex-shrink-0">
                        {contact.avatarUrl && <AvatarImage src={contact.avatarUrl} alt={contact.name} className="!rounded-[9px]" />}
                        <AvatarFallback className="!rounded-[9px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {(contact.name || contact.email || '?').charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{contact.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{contact.email}</div>
                      </div>
                    </Button>
                  ))
                ) : (
                  <>
                    {contactSearchQuery.trim() ? (
                      <>
                        <div className="px-2 py-1.5 text-sm text-muted-foreground text-center">{t.mail.composePage.noPeopleFound}</div>
                        <div className="-mx-1 my-1 h-px bg-border" />
                        <Button
                          variant="ghost"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={async () => {
                            const email = contactSearchQuery.trim();
                            if (email) {
                              addRecipient(email);
                              const localPart = email.includes('@') ? email.split('@')[0] : email;
                              const parts = localPart.split(/[._-]/);
                              const firstName = parts[0] || localPart;
                              const lastName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
                              try {
                                await createPersonMutation.mutateAsync({
                                  firstName,
                                  lastName,
                                  email: email.includes('@') ? email : `${email}@unknown.com`,
                                });
                                toast.success(t.mail.composePage.personCreated);
                              } catch {
                                toast.error(t.mail.composePage.failedToCreatePerson);
                              }
                            }
                          }}
                          className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors text-left"
                        >
                          <UserPlus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium">{t.mail.composePage.createNewPerson}</div>
                            <div className="text-xs text-muted-foreground truncate">{contactSearchQuery.trim()}</div>
                          </div>
                        </Button>
                      </>
                    ) : (
                      <div className="px-2 py-3 text-sm text-muted-foreground text-center">{t.mail.composePage.noRecentPeople}</div>
                    )}
                  </>
                )}
              </div>
            )}

            {(showCc || showBcc) && (
              <div className="space-y-2 mt-2">
                {showCc && (
                  <div className="group flex items-center gap-2">
                    <input
                      type="text"
                      placeholder={st('sweep.weldmail.compose.cc')}
                      data-testid="compose-cc-input"
                      className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                      value={ccRecipients}
                      onChange={(e) => setCcRecipients(e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setShowCc(false); setCcRecipients(''); }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-all"
                    >
                      <X className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  </div>
                )}
                {showBcc && (
                  <div className="group flex items-center gap-2">
                    <input
                      type="text"
                      placeholder={st('sweep.weldmail.compose.bcc')}
                      data-testid="compose-bcc-input"
                      className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                      value={bccRecipients}
                      onChange={(e) => setBccRecipients(e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setShowBcc(false); setBccRecipients(''); }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-all"
                    >
                      <X className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-b border-gray-100 dark:border-border/50 my-2" />

          {/* Message Body */}
          <div className="flex-1 py-2 overflow-y-auto">
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              data-testid="compose-body"
              data-placeholder={t.mail.composePage.writePlaceholder}
              className="w-full min-h-[200px] text-sm outline-none bg-transparent [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-gray-400 dark:[&:empty:before]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1"
              onSelect={checkFormatting}
              onKeyUp={checkFormatting}
              onClick={checkFormatting}
              style={{
                fontSize: `${fontSize}px`,
                textAlign: textAlignment,
              }}
              onBlur={(e) => {
                setBody(e.currentTarget.innerHTML);
              }}
            />

            {/* Attached Files */}
            {attachedFiles.length > 0 && (
              <div className="mt-4 p-4 bg-gray-50 dark:bg-secondary rounded-lg border border-gray-200 dark:border-border">
                <div className="flex items-center gap-2 text-gray-700 dark:text-foreground mb-3">
                  <Paperclip className="h-4 w-4" />
                  <span className="text-sm font-medium">
                    {attachedFiles.length > 1 ? t.mail.composePage.attachmentCountPlural.replace('{n}', String(attachedFiles.length)) : t.mail.composePage.attachmentCount.replace('{n}', String(attachedFiles.length))}
                  </span>
                </div>
                <div className="flex items-start gap-3 flex-wrap">
                  {attachedFiles.map((file, index) => {
                    const isImage = file.type.startsWith('image/');
                    const fileExtension = file.name.split('.').pop()?.toUpperCase() || 'FILE';
                    const fileName = file.name.split('.').slice(0, -1).join('.') || file.name;
                    return (
                      <div key={index} className="relative group">
                        <div className="w-20 h-20 bg-white dark:bg-background rounded-lg overflow-hidden flex items-center justify-center border border-gray-200 dark:border-border">
                          {isImage ? (
                            <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="text-gray-500 dark:text-muted-foreground text-xs font-medium">{fileExtension}</div>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== index))}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-200 dark:bg-accent hover:bg-gray-300 dark:hover:bg-accent rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3 text-gray-600 dark:text-muted-foreground" />
                        </Button>
                        <div className="mt-1.5 max-w-20">
                          <div className="text-xs text-gray-700 dark:text-foreground truncate">{fileName}</div>
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
                    <div className="w-20 h-20 bg-white dark:bg-background hover:bg-gray-100 dark:hover:bg-accent rounded-lg flex items-center justify-center transition-colors border border-gray-200 dark:border-border border-dashed">
                      <Plus className="h-5 w-5 text-gray-400 dark:text-muted-foreground" />
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Toolbar - Bottom */}
          <div className="flex-shrink-0 border-t border-gray-200 dark:border-border -mx-4">
            {/* AI Draft Inline Bar */}
            {aiPromptOpen && (
              <div className="flex items-center gap-1.5 border-b border-gray-200 dark:border-border px-4 py-2">
                <input
                  ref={aiInputRef}
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && aiPrompt.trim()) {
                      e.preventDefault();
                      generateAiDraft(aiPrompt.trim());
                    }
                    if (e.key === 'Escape') {
                      setAiPromptOpen(false);
                    }
                  }}
                  placeholder={t.mail.composePage.aiPlaceholder}
                  className="flex-1 bg-transparent text-sm text-gray-900 dark:text-foreground placeholder:text-gray-400 dark:placeholder:text-muted-foreground outline-none"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  onClick={() => {
                    if (aiPrompt.trim()) {
                      generateAiDraft(aiPrompt.trim());
                    }
                  }}
                  disabled={!aiPrompt.trim()}
                  className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30 transition-opacity"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <div className="flex items-center gap-1 flex-wrap px-4 h-[53px]">
              {/* Font Size */}
              <Select value={fontSize} onValueChange={(value) => { setFontSize(value); focusEditor(); }}>
                <SelectTrigger className="h-7 w-[56px] text-[13.5px] border-0 shadow-none hover:bg-gray-100 dark:hover:bg-accent data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-accent px-2 rounded-md focus:ring-0 focus:ring-offset-0 focus:outline-none">
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

              <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

              {/* Text Formatting */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBold} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", isBold && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.bold}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                  <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleItalic} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", isItalic && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.italic}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="19" y1="4" x2="10" y2="4" />
                  <line x1="14" y1="20" x2="5" y2="20" />
                  <line x1="15" y1="4" x2="9" y2="20" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleUnderline} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", isUnderline && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.underline}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
                  <line x1="4" y1="21" x2="20" y2="21" />
                </svg>
              </Button>

              <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

              {/* Lists */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBulletList} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.bulletList}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <circle cx="4" cy="6" r="1" fill="currentColor" />
                  <circle cx="4" cy="12" r="1" fill="currentColor" />
                  <circle cx="4" cy="18" r="1" fill="currentColor" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleNumberedList} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.numberedList}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="10" y1="6" x2="21" y2="6" />
                  <line x1="10" y1="12" x2="21" y2="12" />
                  <line x1="10" y1="18" x2="21" y2="18" />
                  <path d="M4 6h1v4" />
                  <path d="M4 10h2" />
                  <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
                </svg>
              </Button>

              <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

              {/* Link & Emoji */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleLink} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.insertLink}>
                <Link className="h-4 w-4" />
              </Button>
              {/* Emoji picker - hidden on mobile */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} className="hidden md:inline-flex p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors h-auto w-auto" title={t.mail.toolbar.insertEmoji}>
                    <Smile className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start" side="top">
                  <div className="grid grid-cols-8 gap-1">
                    {['😀', '😂', '😊', '😍', '🥰', '😎', '🤔', '😢', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '❤️', '🔥', '✨', '⭐', '💯', '✅', '❌', '⚠️', '📧'].map((emoji) => (
                      <Button
                        key={emoji}
                        variant="ghost"
                        onMouseDown={preventFocusLoss}
                        onClick={() => insertEmoji(emoji)}
                        className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded text-lg h-auto w-auto"
                      >
                        {emoji}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

              {/* Attachment */}
              <label className="cursor-pointer" onMouseDown={preventFocusLoss}>
                <input
                  type="file"
                  className="hidden"
                  multiple
                  data-testid="compose-attach-input"
                  onChange={(e) => {
                    if (e.target.files) {
                      setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                    }
                  }}
                />
                <div className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.attachFile}>
                  <Paperclip className="h-4 w-4" />
                </div>
              </label>

              <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

              {/* AI Draft */}
              <Button
                type="button"
                variant="ghost"
                onMouseDown={preventFocusLoss}
                onClick={() => !isGeneratingAiDraft && setAiPromptOpen(!aiPromptOpen)}
                disabled={isGeneratingAiDraft}
                className={cn(
                  "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
                  aiPromptOpen
                    ? "bg-gray-100 dark:bg-secondary"
                    : "hover:bg-gray-100 dark:hover:bg-secondary"
                )}
                title={isGeneratingAiDraft ? t.mail.composePage.generatingAiDraft : t.mail.composePage.aiDraft}
              >
                {isGeneratingAiDraft ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin opacity-60" />
                ) : (
                  <img
                    src="/assets/images/weldagent/logo-light.png"
                    alt={t.mail.composePage.aiDraft}
                    width={18}
                    height={18}
                    className={cn(
                      "transition-opacity",
                      aiPromptOpen ? "opacity-100" : "opacity-60 hover:opacity-100"
                    )}
                  />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
