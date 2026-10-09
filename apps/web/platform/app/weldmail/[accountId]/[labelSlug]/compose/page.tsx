
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
  User,
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
import { Command, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format, addDays } from 'date-fns';
import { mailApi } from '../../../lib/api-client';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type { MailDraftRow } from '@weldsuite/app-api-client/domains/mail-drafts';
import { buildComposeBodies, plainTextToHtml, type ComposeBodies } from '@/app/weldmail/lib/compose-body';
import type { DraftFields } from '@/app/weldmail/lib/draft-autosave';
import { useDraftAutosave } from '@/app/weldmail/lib/use-draft-autosave';
import {
  usePersonSearch,
  useRecentCorrespondents,
  type Person,
} from '@/hooks/queries/use-people-queries';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { useComposeSafe } from '@/contexts/compose-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { ComposeAttachButton } from '@/app/weldmail/components/compose-attach-button';
import {
  MAX_EMAIL_SIZE_BYTES,
  MailAttachmentUploadError,
  emailSizeExceedsLimit,
  uploadMailAttachments,
  type MailAttachmentRef,
  type MailUploadClient,
} from '@/app/weldmail/lib/upload-attachments';
import { runEditorCommand, isEditorCommandActive } from '@weldsuite/ui/lib/editor-commands';

interface PersonSuggestion {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

// The subset of a person row the recipient autocomplete needs. Search results
// carry a `displayName`; recent correspondents do not.
interface PersonLike {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

// A complete, syntactically valid email address (used to decide whether Enter
// should commit the typed text verbatim or resolve the highlighted suggestion).
const isCompleteEmail = (value: string) => /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/.test(value.trim());

interface ComposePageProps {
  accountId?: string;
  labelSlug?: string;
  returnUrl?: string;
}

type ComposeContextValue = ReturnType<typeof useComposeSafe>;

// Everything the send / save-draft flows read from the compose form.
interface ComposeFormSnapshot {
  toRecipients: string[];
  toInput: string;
  subject: string;
  body: string;
  ccRecipients: string;
  bccRecipients: string;
  attachedFiles: File[];
  scheduledTime: Date | null;
}

const EMOJIS = ['😀', '😂', '😊', '😍', '🥰', '😎', '🤔', '😢', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '❤️', '🔥', '✨', '⭐', '💯', '✅', '❌', '⚠️', '📧'];

const parseRecipients = (str: string): string[] =>
  str.split(/[,;]/).map((e) => e.trim()).filter((e) => e.length > 0);

const parseOptionalRecipients = (str: string): string[] | undefined =>
  (str ? parseRecipients(str) : undefined);

// The committed recipients plus whatever is still typed in the To input.
const withPendingInput = (recipients: string[], input: string): string[] => {
  const pending = input.trim();
  return pending ? [...recipients, pending] : [...recipients];
};

const attachmentsOrUndefined = (attachments: MailAttachmentRef[]): MailAttachmentRef[] | undefined =>
  (attachments.length > 0 ? attachments : undefined);

const getErrorStatus = (err: unknown): number | undefined => {
  const e = err as { status?: number; response?: { status?: number } } | undefined;
  return e?.status || e?.response?.status;
};

// Enter/Tab (without Ctrl/Cmd) commits the typed recipient.
const isCommitKey = (e: React.KeyboardEvent): boolean =>
  (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey;

// Ctrl/Cmd+Enter sends the message.
const isSendShortcut = (e: React.KeyboardEvent): boolean =>
  !e.nativeEvent.isComposing && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;

// The text before a trailing comma/semicolon, or null when there is none.
const trailingDelimiterBody = (value: string): string | null =>
  (/[,;]$/.test(value) ? value.slice(0, -1).trim() : null);

const toPersonSuggestion = (p: PersonLike): PersonSuggestion => ({
  id: p.id,
  name: p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '',
  email: p.email ?? '',
  avatarUrl: p.avatarUrl ?? null,
});

function getInitialComposeValues(composeContext: ComposeContextValue) {
  const data = composeContext?.composeData;
  if (!data || !(data.to || data.subject || data.body)) {
    return { to: [] as string[], subject: '', body: '' };
  }
  return {
    to: data.to ? parseRecipients(data.to) : [],
    subject: data.subject || '',
    body: data.body || '',
  };
}

interface LoadedDraftFields {
  to?: string[];
  subject?: string;
  cc?: string;
  bcc?: string;
  body?: string;
  inReplyTo?: string;
}

function extractDraftFields(draft: MailDraftRow): LoadedDraftFields {
  const fields: LoadedDraftFields = {};
  if (draft.to && draft.to.length > 0) fields.to = draft.to;
  if (draft.subject) fields.subject = draft.subject;
  if (draft.cc?.length) fields.cc = draft.cc.join(', ');
  if (draft.bcc?.length) fields.bcc = draft.bcc.join(', ');
  // A draft made elsewhere may only have a text part; the editor needs markup.
  const draftBody = draft.htmlBody || (draft.body ? plainTextToHtml(draft.body) : '');
  if (draftBody) fields.body = draftBody;
  if (draft.inReplyTo) fields.inReplyTo = draft.inReplyTo;
  return fields;
}

interface DraftFieldSetters {
  setToRecipients: (to: string[]) => void;
  setSubject: (subject: string) => void;
  setCcRecipients: (cc: string) => void;
  setShowCc: (show: boolean) => void;
  setBccRecipients: (bcc: string) => void;
  setShowBcc: (show: boolean) => void;
  setEditorContent: (html: string) => void;
  setInReplyTo: (id: string) => void;
}

function applyDraftFields(fields: LoadedDraftFields, setters: DraftFieldSetters) {
  if (fields.to) setters.setToRecipients(fields.to);
  if (fields.subject) setters.setSubject(fields.subject);
  if (fields.cc !== undefined) {
    setters.setCcRecipients(fields.cc);
    setters.setShowCc(true);
  }
  if (fields.bcc !== undefined) {
    setters.setBccRecipients(fields.bcc);
    setters.setShowBcc(true);
  }
  if (fields.body) setters.setEditorContent(fields.body);
  if (fields.inReplyTo) setters.setInReplyTo(fields.inReplyTo);
}

type DraftFormSnapshot = Pick<
  ComposeFormSnapshot,
  'toRecipients' | 'toInput' | 'subject' | 'body' | 'ccRecipients' | 'bccRecipients'
>;

// `editorHtml` is the live editor content. The form's `body` only follows it on
// blur, so it is just the fallback for when the editor is not mounted.
function buildDraftFields(
  form: DraftFormSnapshot,
  editorHtml: string | undefined,
  inReplyTo: string | undefined,
): DraftFields {
  const { body, htmlBody } = buildComposeBodies(editorHtml ?? form.body);
  return {
    subject: form.subject,
    to: withPendingInput(form.toRecipients, form.toInput),
    cc: parseRecipients(form.ccRecipients),
    bcc: parseRecipients(form.bccRecipients),
    body,
    htmlBody,
    inReplyTo,
  };
}

// Schedule helpers (mutate/return the date the same way the picker always has).
function scheduleForDate(date: Date, current: Date | null): Date {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    date.setHours(now.getHours(), now.getMinutes() + 1, 0, 0);
  } else {
    date.setHours(current?.getHours() ?? 9, current?.getMinutes() ?? 0, 0, 0);
  }
  return date;
}

function scheduleWithHour(current: Date | null, value: string): Date {
  const hours = Number.parseInt(value);
  const newDate = current ? new Date(current) : new Date();
  const mins = current?.getMinutes() ?? new Date().getMinutes();
  newDate.setHours(hours, mins, 0, 0);
  if (newDate < new Date()) {
    newDate.setMinutes(new Date().getMinutes() + 1);
  }
  return newDate;
}

function scheduleWithMinute(current: Date | null, value: string): Date {
  const minutes = Number.parseInt(value);
  const newDate = current ? new Date(current) : new Date();
  newDate.setHours(current?.getHours() ?? new Date().getHours(), minutes, 0, 0);
  return newDate;
}

function availableHours(scheduledTime: Date | null): number[] {
  const now = new Date();
  const selectedDate = scheduledTime || now;
  const isToday = selectedDate.toDateString() === now.toDateString();
  const minHour = isToday ? now.getHours() : 0;
  return Array.from({ length: 24 }, (_, i) => i).filter((i) => i >= minHour);
}

function availableMinutes(scheduledTime: Date | null): number[] {
  const now = new Date();
  const selectedDate = scheduledTime || now;
  const isToday = selectedDate.toDateString() === now.toDateString();
  const selectedHour = scheduledTime?.getHours() ?? now.getHours();
  const isSameHour = isToday && selectedHour === now.getHours();
  const minMinute = isSameHour ? now.getMinutes() + 1 : 0;
  return Array.from({ length: 60 }, (_, i) => i).filter((i) => i >= minMinute);
}

function useComposeRouteParams({ accountId: accountIdProp, labelSlug: labelSlugProp, returnUrl: returnUrlProp }: ComposePageProps) {
  const params = useParams();
  const searchParams = useSearchParams();
  return {
    draftId: searchParams?.get('draftId') || null,
    inReplyToParam: searchParams?.get('inReplyTo') || null,
    returnUrlParam: returnUrlProp || searchParams?.get('returnUrl') || null,
    accountId: accountIdProp || (params?.accountId as string),
    labelSlug: labelSlugProp || (params?.labelSlug as string),
  };
}

// Sync from compose context if URL params were not provided
function useComposeContextSync({
  contextInReplyTo,
  contextPreviousUrl,
  draftId,
  inReplyTo,
  inReplyToParam,
  returnUrlParam,
  setInReplyTo,
  returnUrl,
}: {
  contextInReplyTo: string | undefined;
  contextPreviousUrl: string | null | undefined;
  draftId: string | null;
  inReplyTo: string | undefined;
  inReplyToParam: string | null;
  returnUrlParam: string | null;
  setInReplyTo: (id: string) => void;
  returnUrl: { current: string | null };
}) {
  useEffect(() => {
    if (!draftId && !inReplyToParam && contextInReplyTo && !inReplyTo) {
      setInReplyTo(contextInReplyTo);
    }
    if (!returnUrlParam && contextPreviousUrl && !returnUrl.current) {
      returnUrl.current = contextPreviousUrl;
    }
  }, [contextInReplyTo, contextPreviousUrl, draftId, inReplyTo, inReplyToParam, returnUrlParam, setInReplyTo, returnUrl]);
}

// Initialize editor with body from compose context
function useInitEditorFromContext(
  composeContext: ComposeContextValue,
  draftId: string | null,
  editorRef: React.RefObject<HTMLDivElement | null>,
  isMinimizingRef: { current: boolean },
) {
  const hasInitializedFromContext = useRef(false);
  useEffect(() => {
    if (!hasInitializedFromContext.current && !draftId && composeContext?.composeData.body && editorRef.current) {
      editorRef.current.innerHTML = composeContext.composeData.body;
      hasInitializedFromContext.current = true;
      // Close the floating panel if it's open (but not if we're minimizing)
      if (composeContext.isComposeOpen && !isMinimizingRef.current) {
        composeContext.closeCompose();
      }
    }
  }, [composeContext, draftId, editorRef, isMinimizingRef]);
}

// Load draft from API when draftId is provided
function useLoadDraft(
  draftId: string | null,
  onLoaded: (draft: MailDraftRow) => void,
  onFailed: () => void,
) {
  const { mailDrafts } = useAppApi();
  const hasLoadedDraft = useRef(false);
  useEffect(() => {
    if (!draftId || hasLoadedDraft.current) return;
    hasLoadedDraft.current = true;
    // The API answers `{ data }` (no `success` flag) and rejects on failure.
    mailDrafts
      .get(draftId)
      .then((result) => {
        if (result.data) onLoaded(result.data);
        else onFailed();
      })
      .catch(onFailed);
  }, [draftId, mailDrafts, onLoaded, onFailed]);
}

function useDismissOnOutsideClick(
  containerRef: React.RefObject<HTMLElement | null>,
  inputRef: React.RefObject<HTMLElement | null>,
  setVisible: (visible: boolean) => void,
) {
  useEffect(() => {
    const isOutside = (el: HTMLElement | null, target: Node) => !!el && !el.contains(target);
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (isOutside(containerRef.current, target) && isOutside(inputRef.current, target)) {
        setVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [containerRef, inputRef, setVisible]);
}

// Person autocomplete
function useContactSuggestions(accountId: string) {
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isSearching = show && query.trim().length > 0;
  const personSearchResult = usePersonSearch(query, isSearching);
  const recentPersonsResult = useRecentCorrespondents(accountId, show && !isSearching);
  const isLoading = isSearching ? personSearchResult.isLoading : recentPersonsResult.isLoading;

  const contacts: PersonSuggestion[] = useMemo(() => {
    const raw: PersonLike[] = isSearching
      ? (personSearchResult.data?.data ?? [])
      : (recentPersonsResult.data?.data ?? []);
    return raw.map(toPersonSuggestion);
  }, [isSearching, personSearchResult.data, recentPersonsResult.data]);

  // Close suggestions when clicking outside
  useDismissOnOutsideClick(containerRef, inputRef, setShow);

  return { show, setShow, query, setQuery, inputRef, containerRef, isLoading, contacts };
}

type ContactSuggestionsApi = ReturnType<typeof useContactSuggestions>;

// Handlers for the To field: chips, typing, Enter/Tab/comma commits, quick-create.
function useRecipientInput({
  toRecipients,
  setToRecipients,
  toInput,
  setToInput,
  suggestions,
}: {
  toRecipients: string[];
  setToRecipients: React.Dispatch<React.SetStateAction<string[]>>;
  toInput: string;
  setToInput: (value: string) => void;
  suggestions: ContactSuggestionsApi;
}) {
  const st = useTranslations();
  const suppressBlurCommitRef = useRef(false);
  const [createPersonQuery, setCreatePersonQuery] = useState<string | null>(null);

  const addRecipient = (email: string) => {
    const trimmed = email.trim();
    if (trimmed && !toRecipients.includes(trimmed)) {
      setToRecipients((prev) => [...prev, trimmed]);
    }
    setToInput('');
    suggestions.setQuery('');
    suggestions.setShow(false);
    suggestions.inputRef.current?.focus();
  };

  const handleToInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // If user types a comma or semicolon, confirm the current input
    const confirmed = trailingDelimiterBody(value);
    if (confirmed !== null) {
      if (confirmed) addRecipient(confirmed);
      return;
    }
    setToInput(value);
    suggestions.setQuery(value.trim());
    suggestions.setShow(true);
  };

  // When the user has typed a partial name/email and a suggestion is shown,
  // Enter/Tab should resolve to the highlighted (first) contact's email —
  // not commit the raw typed text, which otherwise adds a bad chip and forces
  // the real address to be entered a second time. A fully-typed email is
  // respected verbatim.
  const commitTypedRecipient = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const trimmed = toInput.trim();
    const firstSuggestion =
      suggestions.show && trimmed && !isCompleteEmail(trimmed)
        ? suggestions.contacts.find((c) => c.email && !toRecipients.includes(c.email))
        : undefined;
    if (firstSuggestion) {
      e.preventDefault();
      addRecipient(firstSuggestion.email);
    } else if (trimmed) {
      e.preventDefault();
      addRecipient(trimmed);
    }
  };

  const handleToInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isCommitKey(e)) {
      commitTypedRecipient(e);
      return;
    }
    if (e.key === 'Backspace' && !toInput && toRecipients.length > 0) {
      setToRecipients((prev) => prev.slice(0, -1));
    }
  };

  // Commit pending input on blur (with small delay for click events).
  // Opening the create-person dialog blurs the field; that must not turn the
  // unfinished query into a recipient chip.
  const handleToInputBlur = () => {
    setTimeout(() => {
      if (suppressBlurCommitRef.current) {
        suppressBlurCommitRef.current = false;
        return;
      }
      if (toInput.trim()) {
        addRecipient(toInput);
      }
    }, 200);
  };

  const handleToInputFocus = () => {
    suggestions.setQuery(toInput.trim());
    suggestions.setShow(true);
  };

  const removeRecipient = (email: string) => {
    setToRecipients((prev) => prev.filter((r) => r !== email));
    suggestions.inputRef.current?.focus();
  };

  const handleCreatePerson = () => {
    const query = suggestions.query.trim();
    if (!query) return;
    suppressBlurCommitRef.current = true;
    suggestions.setShow(false);
    setCreatePersonQuery(query);
  };

  const handlePersonCreated = (person: Person) => {
    const email = person.email?.trim();
    if (email) {
      addRecipient(email);
      return;
    }
    setToInput('');
    suggestions.setQuery('');
    toast.info(st('sweep.entities.personCreatedNeedsEmail'));
  };

  return {
    addRecipient,
    handleToInputChange,
    handleToInputKeyDown,
    handleToInputBlur,
    handleToInputFocus,
    removeRecipient,
    handleCreatePerson,
    createPersonQuery,
    setCreatePersonQuery,
    handlePersonCreated,
  };
}

function useAiDraft({
  accountId,
  inReplyTo,
  subject,
  onSubject,
  onBody,
}: {
  accountId: string;
  inReplyTo: string | undefined;
  subject: string;
  onSubject: (subject: string) => void;
  onBody: (html: string) => void;
}) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingAiDraft, setIsGeneratingAiDraft] = useState(false);
  const aiInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (aiPromptOpen && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 50);
    }
  }, [aiPromptOpen]);

  const applyDraft = (draft: { subject: string; body: string }) => {
    if (draft.subject && !subject) {
      onSubject(draft.subject);
    }
    if (draft.body) {
      onBody(formatAiBody(draft.body));
    }
  };

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
        applyDraft(result.data);
        toast.success(t.mail.composePage.aiDraftGenerated);
      }
    } catch (err) {
      toast.error(
        getErrorStatus(err) === 402
          ? t.mail.composePage.insufficientAiCredits
          : t.mail.composePage.failedToGenerateDraft,
      );
    } finally {
      setIsGeneratingAiDraft(false);
    }
  };

  return { aiPromptOpen, setAiPromptOpen, aiPrompt, setAiPrompt, isGeneratingAiDraft, aiInputRef, generateAiDraft };
}

type AiDraftApi = ReturnType<typeof useAiDraft>;

// contentEditable formatting (bold/italic/lists/links/emoji) with selection
// save/restore so toolbar clicks don't lose the caret.
function useEditorFormatting(editorRef: React.RefObject<HTMLDivElement | null>) {
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);

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
    setIsBold(isEditorCommandActive('bold'));
    setIsItalic(isEditorCommandActive('italic'));
    setIsUnderline(isEditorCommandActive('underline'));
  };

  const focusEditor = () => {
    if (editorRef.current) {
      editorRef.current.focus();
      restoreSelection();
    }
  };

  const executeCommand = (command: string, value?: string) => {
    // Focus the editor and restore selection before executing command
    if (editorRef.current) {
      editorRef.current.focus();
      restoreSelection();
      runEditorCommand(command, value);
      saveSelection();
    }
  };

  const runCommand = (command: string, value?: string) => {
    executeCommand(command, value);
    checkFormatting();
  };

  const handleLink = () => {
    const url = prompt('Enter URL:');
    if (url) executeCommand('createLink', url);
    checkFormatting();
  };

  return {
    isBold,
    isItalic,
    isUnderline,
    checkFormatting,
    focusEditor,
    handleBold: () => runCommand('bold'),
    handleItalic: () => runCommand('italic'),
    handleUnderline: () => runCommand('underline'),
    handleBulletList: () => runCommand('insertUnorderedList'),
    handleNumberedList: () => runCommand('insertOrderedList'),
    handleLink,
    insertEmoji: (emoji: string) => runCommand('insertText', emoji),
  };
}

type EditorFormattingApi = ReturnType<typeof useEditorFormatting>;

function useComposeSend({
  accountId,
  returnUrl,
  editorRef,
  form,
  onSent,
}: {
  accountId: string;
  returnUrl: { current: string | null };
  editorRef: React.RefObject<HTMLDivElement | null>;
  form: ComposeFormSnapshot;
  /** Runs after a send or schedule succeeded, e.g. to remove the draft it came from. */
  onSent: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const cp = t.mail.composePage;
  const router = useRouter();
  const { getClient } = useAppApiClient();
  const [isSending, setIsSending] = useState(false);

  const finishSend = async (fallbackUrl: string) => {
    // The message is out, so the draft it was written in must leave Drafts.
    await onSent();
    window.dispatchEvent(new Event('mail:refresh'));
    router.push(returnUrl.current || fallbackUrl);
  };

  const notifyEmailTooLarge = () =>
    toast.error(cp.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));

  // Uploads the attachments, or shows the failure toast and returns null.
  const uploadAttachmentsOrNotify = async (
    resolveClient: () => Promise<MailUploadClient>,
  ): Promise<MailAttachmentRef[] | null> => {
    try {
      const client = await resolveClient();
      return await uploadMailAttachments(client, accountId, form.attachedFiles);
    } catch (err) {
      const filename = err instanceof MailAttachmentUploadError ? err.filename : 'file';
      toast.error(cp.failedToUpload.replace('{filename}', filename));
      return null;
    }
  };

  const sendScheduled = async (toAddresses: string[], bodies: ComposeBodies, scheduledFor: Date) => {
    setIsSending(true);
    try {
      const client = await getClient();
      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, form.attachedFiles)) {
        notifyEmailTooLarge();
        return;
      }

      const uploadedAttachments = await uploadAttachmentsOrNotify(() => Promise.resolve(client));
      if (!uploadedAttachments) return;

      const result = await mailApi.scheduled.schedule({
        accountId,
        to: toAddresses,
        cc: parseOptionalRecipients(form.ccRecipients),
        bcc: parseOptionalRecipients(form.bccRecipients),
        subject: form.subject.trim() || cp.noSubject,
        body,
        htmlBody,
        scheduledFor,
        attachments: attachmentsOrUndefined(uploadedAttachments),
      });
      if (result.success) {
        toast.success(cp.emailScheduledFor.replace('{date}', format(scheduledFor, 'PPp')));
        await finishSend(`/weldmail/${accountId}/sent`);
      } else {
        toast.error(result.error || cp.failedToScheduleEmail);
      }
    } catch {
      toast.error(cp.failedToScheduleEmail);
    } finally {
      setIsSending(false);
    }
  };

  const sendNow = async (toAddresses: string[], bodies: ComposeBodies) => {
    setIsSending(true);
    try {
      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, form.attachedFiles)) {
        notifyEmailTooLarge();
        return;
      }

      const uploadedAttachments = await uploadAttachmentsOrNotify(getClient);
      if (!uploadedAttachments) return;

      const result = await mailApi.messages.send(accountId, {
        to: toAddresses,
        cc: parseOptionalRecipients(form.ccRecipients),
        bcc: parseOptionalRecipients(form.bccRecipients),
        subject: form.subject.trim() || cp.noSubject,
        body,
        htmlBody,
        attachments: attachmentsOrUndefined(uploadedAttachments),
      });

      if (result.success) {
        toast.success(cp.emailSentSuccessfully);
        await finishSend(`/weldmail/${accountId}/sent`);
      } else {
        toast.error(result.error || cp.failedToSendEmail);
      }
    } catch {
      toast.error(cp.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleSend = async () => {
    if (isSending) return;
    // Read the editor directly so Ctrl+Enter sends text that has not blurred yet.
    const bodies = buildComposeBodies(editorRef.current ? editorRef.current.innerHTML : form.body);
    // Commit any pending input
    const toAddresses = withPendingInput(form.toRecipients, form.toInput);
    if (toAddresses.length === 0) {
      toast.error(cp.atLeastOneRecipient);
      return;
    }
    if (!bodies.body) {
      toast.error(cp.enterMessage);
      return;
    }
    if (form.scheduledTime) {
      await sendScheduled(toAddresses, bodies, form.scheduledTime);
      return;
    }
    await sendNow(toAddresses, bodies);
  };

  return { isSending, handleSend };
}

function useDraftActions({
  editorRef,
  form,
  inReplyTo,
  autosave,
  onClose,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  form: ComposeFormSnapshot;
  inReplyTo: string | undefined;
  autosave: Pick<ReturnType<typeof useDraftAutosave>, 'saveNow' | 'discard'>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const cp = t.mail.composePage;

  // Creates the draft, or updates the one autosave already made.
  const handleSaveDraft = async () => {
    const saved = await autosave.saveNow(buildDraftFields(form, editorRef.current?.innerHTML, inReplyTo));
    if (saved) {
      toast.success(cp.draftSaved);
    } else {
      toast.error(cp.failedToSaveDraft);
    }
    onClose();
  };

  const handleDeleteDraft = async () => {
    const result = await autosave.discard();
    if (result === 'deleted') {
      toast.success(cp.draftDeleted);
    } else if (result === 'failed') {
      toast.error(cp.failedToSaveDraft);
    }
    onClose();
  };

  return { handleSaveDraft, handleDeleteDraft };
}

export default function ComposePage(props: ComposePageProps = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const { draftId, inReplyToParam, returnUrlParam, accountId, labelSlug } = useComposeRouteParams(props);
  const textareaRef = useRef<HTMLDivElement>(null);
  const composeContext = useComposeSafe();

  // Form state - initialize from compose context if available
  const [initial] = useState(() => getInitialComposeValues(composeContext));
  const [toRecipients, setToRecipients] = useState<string[]>(initial.to);
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);

  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [ccRecipients, setCcRecipients] = useState('');
  const [bccRecipients, setBccRecipients] = useState('');
  const [fontSize, setFontSize] = useState('14');
  const [textAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [scheduledTime, setScheduledTime] = useState<Date | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>(
    () => composeContext?.composeData.attachedFiles ?? [],
  );

  // Use URL params (most reliable) with compose context as fallback
  const returnUrl = useRef<string | null>(returnUrlParam || composeContext?.previousUrl || null);
  const [bodyHasText, setBodyHasText] = useState(false);
  // An opened draft is not the user's form until it has loaded; autosaving the
  // empty form over it would wipe it.
  const [draftLoaded, setDraftLoaded] = useState(!draftId);
  const [inReplyTo, setInReplyTo] = useState<string | undefined>(inReplyToParam || composeContext?.composeData.inReplyTo || undefined);
  const isMinimizingRef = useRef(false);

  useComposeContextSync({
    contextInReplyTo: composeContext?.composeData.inReplyTo,
    contextPreviousUrl: composeContext?.previousUrl,
    draftId,
    inReplyTo,
    inReplyToParam,
    returnUrlParam,
    setInReplyTo,
    returnUrl,
  });
  useInitEditorFromContext(composeContext, draftId, textareaRef, isMinimizingRef);

  const setEditorContent = (html: string) => {
    setBody(html);
    if (textareaRef.current) {
      textareaRef.current.innerHTML = html;
    }
  };

  const applyLoadedDraft = (draft: MailDraftRow) => {
    applyDraftFields(extractDraftFields(draft), {
      setToRecipients,
      setSubject,
      setCcRecipients,
      setShowCc,
      setBccRecipients,
      setShowBcc,
      setEditorContent,
      setInReplyTo,
    });
    setDraftLoaded(true);
  };
  const handleDraftLoadFailed = () => toast.error(t.mail.composePage.failedToLoadDraft);
  useLoadDraft(draftId, applyLoadedDraft, handleDraftLoadFailed);

  const autosave = useDraftAutosave({ accountId, initialDraftId: draftId, enabled: draftLoaded });

  const ai = useAiDraft({ accountId, inReplyTo, subject, onSubject: setSubject, onBody: setEditorContent });
  const suggestions = useContactSuggestions(accountId);
  const recipientInput = useRecipientInput({ toRecipients, setToRecipients, toInput, setToInput, suggestions });
  const formatting = useEditorFormatting(textareaRef);

  const handleClose = () => {
    router.push(returnUrl.current || `/weldmail/${accountId}/${labelSlug}`);
  };

  const handleMinimize = () => {
    if (!composeContext) {
      // Fallback if context not available
      handleClose();
      return;
    }
    isMinimizingRef.current = true;

    // Get the current body content from the editor
    const currentBody = textareaRef.current?.innerHTML || body;

    // The floating panel keeps updating the draft this page already made.
    autosave.handOff();

    // Transfer data to floating panel
    composeContext.minimizeToPanel({
      to: withPendingInput(toRecipients, toInput).join(', '),
      subject,
      body: currentBody,
      cc: ccRecipients,
      bcc: bccRecipients,
      attachedFiles,
      scheduledTime,
      accountId,
    });

    // Navigate back to where the user came from
    handleClose();
  };

  const form: ComposeFormSnapshot = {
    toRecipients,
    toInput,
    subject,
    body,
    ccRecipients,
    bccRecipients,
    attachedFiles,
    scheduledTime,
  };
  const { isSending, handleSend } = useComposeSend({
    accountId,
    returnUrl,
    editorRef: textareaRef,
    form,
    onSent: autosave.discard,
  });
  const { handleSaveDraft, handleDeleteDraft } = useDraftActions({
    editorRef: textareaRef,
    form,
    inReplyTo,
    autosave,
    onClose: handleClose,
  });

  // Reports the form to the autosave. The first report is the baseline (the
  // pre-filled form, or the draft that was just loaded) and is not saved.
  const { schedule: scheduleDraftSave } = autosave;
  const reportDraftChange = (editorHtml: string | undefined) =>
    scheduleDraftSave(buildDraftFields(form, editorHtml, inReplyTo));
  useEffect(() => {
    scheduleDraftSave(
      buildDraftFields(
        { toRecipients, toInput, subject, body, ccRecipients, bccRecipients },
        textareaRef.current?.innerHTML,
        inReplyTo,
      ),
    );
  }, [scheduleDraftSave, draftLoaded, toRecipients, toInput, subject, body, ccRecipients, bccRecipients, inReplyTo]);

  const hasContent = Boolean(toRecipients.length > 0 || toInput || subject || body || bodyHasText);

  return (
    <div
      role="presentation"
      className="h-full flex flex-col bg-white dark:bg-background"
      onKeyDown={(e) => {
        if (!isSendShortcut(e)) return;
        e.preventDefault();
        void handleSend();
      }}
    >
      {/* Header */}
      <div className="px-4 h-[53px] flex items-center border-b border-gray-200 dark:border-border flex-shrink-0">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <CancelControl
              hasContent={hasContent}
              onClose={handleClose}
              onSaveDraft={handleSaveDraft}
              onDeleteDraft={handleDeleteDraft}
            />

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
            <ScheduleControls scheduledTime={scheduledTime} onChange={setScheduledTime} />

            <Button type="button" data-testid="compose-send-btn" onClick={handleSend} disabled={isSending} size="sm" className="px-3" title="Ctrl+Enter">
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
                <ToRecipientsInput
                  recipients={toRecipients}
                  input={toInput}
                  inputRef={suggestions.inputRef}
                  onRemoveRecipient={recipientInput.removeRecipient}
                  onInputChange={recipientInput.handleToInputChange}
                  onInputKeyDown={recipientInput.handleToInputKeyDown}
                  onInputFocus={recipientInput.handleToInputFocus}
                  onInputBlur={recipientInput.handleToInputBlur}
                />
              </div>
              <CcBccToggles
                showCc={showCc}
                showBcc={showBcc}
                onShowCc={() => setShowCc(true)}
                onShowBcc={() => setShowBcc(true)}
              />
            </div>

            {/* Contact Suggestions Dropdown — shadcn popover/command styling */}
            {suggestions.show && (
              <ContactSuggestionsList
                containerRef={suggestions.containerRef}
                isLoading={suggestions.isLoading}
                contacts={suggestions.contacts}
                toRecipients={toRecipients}
                query={suggestions.query}
                onSelect={(contact) => recipientInput.addRecipient(contact.email)}
                onCreatePerson={recipientInput.handleCreatePerson}
              />
            )}

            <QuickAddPersonDialog
              open={recipientInput.createPersonQuery !== null}
              onOpenChange={(open) => {
                if (!open) recipientInput.setCreatePersonQuery(null);
              }}
              initialName={recipientInput.createPersonQuery ?? ''}
              onCreated={recipientInput.handlePersonCreated}
            />

            <CcBccInputs
              showCc={showCc}
              showBcc={showBcc}
              cc={ccRecipients}
              bcc={bccRecipients}
              onCcChange={setCcRecipients}
              onBccChange={setBccRecipients}
              onHideCc={() => { setShowCc(false); setCcRecipients(''); }}
              onHideBcc={() => { setShowBcc(false); setBccRecipients(''); }}
            />
          </div>

          <div className="border-b border-gray-100 dark:border-border/50 my-2" />

          {/* Message Body */}
          <div className="flex-1 py-2 overflow-y-auto">
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              tabIndex={0}
              aria-multiline="true"
              aria-label={t.mail.composePage.writePlaceholder}
              data-testid="compose-body"
              data-placeholder={t.mail.composePage.writePlaceholder}
              className="w-full min-h-[200px] text-sm outline-none bg-transparent [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-gray-400 dark:[&:empty:before]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1"
              onSelect={formatting.checkFormatting}
              onKeyUp={formatting.checkFormatting}
              onClick={formatting.checkFormatting}
              style={{
                fontSize: `${fontSize}px`,
                textAlign: textAlignment,
              }}
              onInput={(e) => {
                setBodyHasText(Boolean(e.currentTarget.textContent?.trim()));
                reportDraftChange(e.currentTarget.innerHTML);
              }}
              onBlur={(e) => {
                setBody(e.currentTarget.innerHTML);
              }}
            />

            {/* Attached Files */}
            <AttachedFilesPanel files={attachedFiles} onFilesChange={setAttachedFiles} />
          </div>

          {/* Toolbar - Bottom */}
          <div className="flex-shrink-0 border-t border-gray-200 dark:border-border -mx-4">
            {/* AI Draft Inline Bar */}
            {ai.aiPromptOpen && (
              <AiDraftBar
                inputRef={ai.aiInputRef}
                value={ai.aiPrompt}
                onChange={ai.setAiPrompt}
                onSubmit={ai.generateAiDraft}
                onClose={() => ai.setAiPromptOpen(false)}
              />
            )}
            <ComposeToolbar
              fontSize={fontSize}
              onFontSizeChange={setFontSize}
              formatting={formatting}
              ai={ai}
              onFilesSelected={(files) => setAttachedFiles((prev) => [...prev, ...files])}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CancelControl({
  hasContent,
  onClose,
  onSaveDraft,
  onDeleteDraft,
}: Readonly<{
  hasContent: boolean;
  onClose: () => void;
  onSaveDraft: () => void;
  onDeleteDraft: () => void;
}>) {
  const { t } = useI18n();

  if (!hasContent) {
    return (
      <Button onClick={onClose} variant="outline" size="sm" className="px-3">
        {t.mail.composePage.cancel}
      </Button>
    );
  }

  return (
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
            onSaveDraft();
          }}
        >
          <CircleCheck className="h-4 w-4 mr-1.5" />
          {t.mail.composePage.saveAndCloseDraft}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onDeleteDraft();
          }}
          className="text-red-600 focus:text-red-600 focus:bg-red-50"
        >
          <Trash2 className="h-4 w-4 mr-1.5 text-red-600" />
          {t.mail.composePage.deleteDraft}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TimeUnitSelect({
  value,
  options,
  onValueChange,
}: Readonly<{
  value: string;
  options: number[];
  onValueChange: (value: string) => void;
}>) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="w-[70px] h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((i) => (
          <SelectItem key={i} value={String(i)}>
            {i.toString().padStart(2, '0')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ScheduleControls({
  scheduledTime,
  onChange,
}: Readonly<{
  scheduledTime: Date | null;
  onChange: (date: Date | null) => void;
}>) {
  const { t } = useI18n();

  return (
    <>
      {/* Scheduled Time Badge */}
      {scheduledTime && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm">
          <span>{format(scheduledTime, 'MMM d, h:mm a')}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
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
              if (date) onChange(scheduleForDate(date, scheduledTime));
            }}
            disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0)) || date > addDays(new Date(), 7)}
            initialFocus
          />
          <div className="border-t border-gray-200 dark:border-border px-3 py-3">
            <div className="text-xs font-medium text-gray-500 dark:text-muted-foreground mb-2">{t.mail.composePage.time}</div>
            <div className="flex items-center gap-2">
              <TimeUnitSelect
                value={String(scheduledTime?.getHours() ?? new Date().getHours())}
                options={availableHours(scheduledTime)}
                onValueChange={(value) => onChange(scheduleWithHour(scheduledTime, value))}
              />
              <span className="text-gray-500 dark:text-muted-foreground">:</span>
              <TimeUnitSelect
                value={String(scheduledTime?.getMinutes() ?? Math.min(new Date().getMinutes() + 1, 59))}
                options={availableMinutes(scheduledTime)}
                onValueChange={(value) => onChange(scheduleWithMinute(scheduledTime, value))}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

function ToRecipientsInput({
  recipients,
  input,
  inputRef,
  onRemoveRecipient,
  onInputChange,
  onInputKeyDown,
  onInputFocus,
  onInputBlur,
}: Readonly<{
  recipients: string[];
  input: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onRemoveRecipient: (email: string) => void;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
}>) {
  const { t } = useI18n();

  return (
    <div
      role="presentation"
      className="flex-1 flex flex-wrap items-center gap-1 min-w-0 min-h-[26px] cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {recipients.map((email) => (
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
              onRemoveRecipient(email);
            }}
            className="flex items-center justify-center rounded-sm p-0.5 text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-200 dark:hover:bg-accent transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 min-w-[120px] h-[26px] text-sm outline-none bg-transparent"
        value={input}
        onChange={onInputChange}
        onKeyDown={onInputKeyDown}
        onFocus={onInputFocus}
        onBlur={onInputBlur}
        placeholder={recipients.length === 0 ? t.mail.composePage.addRecipients : ''}
      />
    </div>
  );
}

function CcBccToggles({
  showCc,
  showBcc,
  onShowCc,
  onShowBcc,
}: Readonly<{
  showCc: boolean;
  showBcc: boolean;
  onShowCc: () => void;
  onShowBcc: () => void;
}>) {
  const st = useTranslations();

  if (showCc && showBcc) return null;

  return (
    <div className="flex items-center gap-0.5">
      {!showCc && (
        <Button
          variant="ghost"
          data-testid="compose-cc-toggle"
          onClick={onShowCc}
          className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-md px-1.5 py-1 transition-colors"
        >
          {st('sweep.weldmail.compose.cc')}
        </Button>
      )}
      {!showBcc && (
        <Button
          variant="ghost"
          data-testid="compose-bcc-toggle"
          onClick={onShowBcc}
          className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-md px-1.5 py-1 transition-colors"
        >
          {st('sweep.weldmail.compose.bcc')}
        </Button>
      )}
    </div>
  );
}

function ExtraRecipientInput({
  placeholder,
  testId,
  value,
  onChange,
  onHide,
}: Readonly<{
  placeholder: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  onHide: () => void;
}>) {
  return (
    <div className="group flex items-center gap-2">
      <input
        type="text"
        placeholder={placeholder}
        data-testid={testId}
        className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onHide}
        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-all"
      >
        <X className="h-3.5 w-3.5 text-gray-400" />
      </Button>
    </div>
  );
}

function CcBccInputs({
  showCc,
  showBcc,
  cc,
  bcc,
  onCcChange,
  onBccChange,
  onHideCc,
  onHideBcc,
}: Readonly<{
  showCc: boolean;
  showBcc: boolean;
  cc: string;
  bcc: string;
  onCcChange: (value: string) => void;
  onBccChange: (value: string) => void;
  onHideCc: () => void;
  onHideBcc: () => void;
}>) {
  const st = useTranslations();

  if (!showCc && !showBcc) return null;

  return (
    <div className="space-y-2 mt-2">
      {showCc && (
        <ExtraRecipientInput
          placeholder={st('sweep.weldmail.compose.cc')}
          testId="compose-cc-input"
          value={cc}
          onChange={onCcChange}
          onHide={onHideCc}
        />
      )}
      {showBcc && (
        <ExtraRecipientInput
          placeholder={st('sweep.weldmail.compose.bcc')}
          testId="compose-bcc-input"
          value={bcc}
          onChange={onBccChange}
          onHide={onHideBcc}
        />
      )}
    </div>
  );
}

function ContactSuggestionItem({
  contact,
  onSelect,
}: Readonly<{
  contact: PersonSuggestion;
  onSelect: (contact: PersonSuggestion) => void;
}>) {
  return (
    <CommandItem value={contact.id} onSelect={() => onSelect(contact)}>
      <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
        {contact.avatarUrl && <AvatarImage src={contact.avatarUrl} alt={contact.name} className="!rounded-[7px]" />}
        <AvatarFallback className="!rounded-[7px] bg-gray-200 dark:bg-muted-foreground/25">
          <User className="size-2.5" />
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-1 min-w-0 items-baseline gap-2">
        <span className="max-w-[60%] font-medium truncate">{contact.name}</span>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground truncate">{contact.email}</span>
      </div>
    </CommandItem>
  );
}

function ContactSuggestionsList({
  containerRef,
  isLoading,
  contacts,
  toRecipients,
  query,
  onSelect,
  onCreatePerson,
}: Readonly<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  isLoading: boolean;
  contacts: PersonSuggestion[];
  toRecipients: string[];
  query: string;
  onSelect: (contact: PersonSuggestion) => void;
  onCreatePerson: () => void;
}>) {
  const { t } = useI18n();
  const available = contacts.filter((c) => !toRecipients.includes(c.email));
  const hasQuery = query.trim().length > 0;

  const renderBody = () => {
    if (isLoading && contacts.length === 0) {
      return (
        <div className="flex items-center justify-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t.mail.composePage.loadingContacts}</span>
        </div>
      );
    }
    if (available.length === 0 && !hasQuery) {
      return <div className="px-2 py-3 text-sm text-muted-foreground text-center">{t.mail.composePage.noRecentPeople}</div>;
    }
    return (
      <>
        {available.map((contact) => (
          <ContactSuggestionItem key={contact.id} contact={contact} onSelect={onSelect} />
        ))}
        {hasQuery && (
          <CommandItem value="__add-recipient" onSelect={onCreatePerson}>
            <Plus />
            <span className="font-medium truncate">{t.mail.composePage.createNewPerson}</span>
          </CommandItem>
        )}
      </>
    );
  };

  // The search runs server-side and the text input lives outside the Command,
  // so cmdk's own filtering is off; mousedown is swallowed to keep the input focused.
  return (
    <div
      ref={containerRef}
      role="presentation"
      onMouseDown={(e) => e.preventDefault()}
      className="absolute left-0 top-full mt-1 w-full max-w-sm bg-popover text-popover-foreground border rounded-md shadow-md z-50 overflow-hidden"
    >
      <Command shouldFilter={false} className="h-auto">
        <CommandList className="max-h-[250px] p-1">{renderBody()}</CommandList>
      </Command>
    </div>
  );
}

function AttachmentThumbnail({
  file,
  onRemove,
}: Readonly<{
  file: File;
  onRemove: () => void;
}>) {
  const isImage = file.type.startsWith('image/');
  const fileExtension = file.name.split('.').pop()?.toUpperCase() || 'FILE';
  const fileName = file.name.split('.').slice(0, -1).join('.') || file.name;

  return (
    <div className="relative group">
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
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-200 dark:bg-accent hover:bg-gray-300 dark:hover:bg-accent rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3 text-gray-600 dark:text-muted-foreground" />
      </Button>
      <div className="mt-1.5 max-w-20">
        <div className="text-xs text-gray-700 dark:text-foreground truncate">{fileName}</div>
      </div>
    </div>
  );
}

// Stable per-File React keys: File objects keep their identity in state, so the
// same file always maps to the same key (and two identical files get distinct keys).
const attachmentKeys = new WeakMap<File, string>();
let attachmentKeyCounter = 0;

function getAttachmentKey(file: File): string {
  let key = attachmentKeys.get(file);
  if (!key) {
    attachmentKeyCounter += 1;
    key = `attachment-${attachmentKeyCounter}`;
    attachmentKeys.set(file, key);
  }
  return key;
}

function AttachedFilesPanel({
  files,
  onFilesChange,
}: Readonly<{
  files: File[];
  onFilesChange: React.Dispatch<React.SetStateAction<File[]>>;
}>) {
  const { t } = useI18n();

  if (files.length === 0) return null;

  const countTemplate = files.length > 1 ? t.mail.composePage.attachmentCountPlural : t.mail.composePage.attachmentCount;

  return (
    <div className="mt-4 p-4 bg-gray-50 dark:bg-secondary rounded-lg border border-gray-200 dark:border-border">
      <div className="flex items-center gap-2 text-gray-700 dark:text-foreground mb-3">
        <Paperclip className="h-4 w-4" />
        <span className="text-sm font-medium">
          {countTemplate.replace('{n}', String(files.length))}
        </span>
      </div>
      <div className="flex items-start gap-3 flex-wrap">
        {files.map((file, index) => (
          <AttachmentThumbnail
            key={getAttachmentKey(file)}
            file={file}
            onRemove={() => onFilesChange((prev) => prev.filter((_, i) => i !== index))}
          />
        ))}
        <label className="cursor-pointer">
          <input
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              const picked = e.target.files;
              if (picked) {
                onFilesChange((prev) => [...prev, ...Array.from(picked)]);
              }
            }}
          />
          <div className="w-20 h-20 bg-white dark:bg-background hover:bg-gray-100 dark:hover:bg-accent rounded-lg flex items-center justify-center transition-colors border border-gray-200 dark:border-border border-dashed">
            <Plus className="h-5 w-5 text-gray-400 dark:text-muted-foreground" />
          </div>
        </label>
      </div>
    </div>
  );
}

function AiDraftBar({
  inputRef,
  value,
  onChange,
  onSubmit,
  onClose,
}: Readonly<{
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}>) {
  const { t } = useI18n();
  const prompt = value.trim();

  return (
    <div className="flex items-center gap-1.5 border-b border-gray-200 dark:border-border px-4 py-2">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && prompt) {
            e.preventDefault();
            onSubmit(prompt);
          }
          if (e.key === 'Escape') {
            onClose();
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
          if (prompt) {
            onSubmit(prompt);
          }
        }}
        disabled={!prompt}
        className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30 transition-opacity"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// Prevent toolbar buttons from stealing focus
const preventFocusLoss = (e: React.MouseEvent) => {
  e.preventDefault();
};

function AiDraftToggle({ ai }: Readonly<{ ai: AiDraftApi }>) {
  const { t } = useI18n();
  const { aiPromptOpen, isGeneratingAiDraft } = ai;

  return (
    <Button
      type="button"
      variant="ghost"
      onMouseDown={preventFocusLoss}
      onClick={() => !isGeneratingAiDraft && ai.setAiPromptOpen(!aiPromptOpen)}
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
  );
}

function ComposeToolbar({
  fontSize,
  onFontSizeChange,
  formatting,
  ai,
  onFilesSelected,
}: Readonly<{
  fontSize: string;
  onFontSizeChange: (size: string) => void;
  formatting: EditorFormattingApi;
  ai: AiDraftApi;
  onFilesSelected: (files: File[]) => void;
}>) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-1 flex-wrap px-4 h-[53px]">
      {/* Font Size */}
      <Select value={fontSize} onValueChange={(value) => { onFontSizeChange(value); formatting.focusEditor(); }}>
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
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleBold} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", formatting.isBold && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.bold}>
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
          <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleItalic} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", formatting.isItalic && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.italic}>
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="19" y1="4" x2="10" y2="4" />
          <line x1="14" y1="20" x2="5" y2="20" />
          <line x1="15" y1="4" x2="9" y2="20" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleUnderline} className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors", formatting.isUnderline && "bg-gray-100 dark:bg-accent")} title={t.mail.toolbar.underline}>
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
          <line x1="4" y1="21" x2="20" y2="21" />
        </svg>
      </Button>

      <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

      {/* Lists */}
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleBulletList} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.bulletList}>
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <circle cx="4" cy="6" r="1" fill="currentColor" />
          <circle cx="4" cy="12" r="1" fill="currentColor" />
          <circle cx="4" cy="18" r="1" fill="currentColor" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleNumberedList} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.numberedList}>
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
      <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={formatting.handleLink} className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors" title={t.mail.toolbar.insertLink}>
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
            {EMOJIS.map((emoji) => (
              <Button
                key={emoji}
                variant="ghost"
                onMouseDown={preventFocusLoss}
                onClick={() => formatting.insertEmoji(emoji)}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded text-lg h-auto w-auto"
              >
                {emoji}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

      <ComposeAttachButton
        title={t.mail.toolbar.attachFile}
        testId="compose-attach-input"
        className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors"
        onFilesSelected={onFilesSelected}
      />

      <div className="w-px h-5 bg-gray-300 dark:bg-border mx-1" />

      {/* AI Draft */}
      <AiDraftToggle ai={ai} />
    </div>
  );
}
