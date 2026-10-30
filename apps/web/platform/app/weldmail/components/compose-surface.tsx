/**
 * The compose-email design: header, From / To / Cc / Bcc / Subject rows, the
 * body editor, attachments, and the footer with the formatting bar, the AI bar
 * and the tool icons. One component rendered by both the floating compose panel
 * and the full-page compose, so a change here shows up in both.
 *
 * It owns what is purely about the surface (formatting, the open bars, the
 * schedule picker); the caller owns the message itself (recipients, subject,
 * body, attachments), the draft, and sending.
 */
import { useEffect, useRef, useState } from 'react';
import {
  X,
  Paperclip,
  Loader2,
  Minus,
  Maximize,
  PictureInPicture2,
  Clock,
  ALargeSmall,
  Variable,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Strikethrough,
  Baseline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  IndentDecrease,
  IndentIncrease,
  RemoveFormatting,
  Plus,
  ArrowUp,
} from 'lucide-react';
import { format, addDays, startOfDay } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { runEditorCommand, isEditorCommandActive } from '@weldsuite/ui/lib/editor-commands';
import { cn } from '@/lib/utils';
import { MAIL_EDITOR_PARAGRAPH_CLASSES } from '../lib/editor-styles';
import { useI18n } from '@/lib/i18n/provider';
import { isFeatureAvailable } from '@/lib/edition';
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { WeldAgentIcon } from '@/components/icons/weldagent-icon';
import { ComposeAttachButton } from '@/app/weldmail/components/compose-attach-button';
import { RecipientsRow, StringRecipientsRow, type RecipientsRowHandle } from '@/app/weldmail/components/compose-recipients';
import { ComposeLinkButton } from '@/app/weldmail/components/compose-link-button';
import { SignaturePicker, useComposeSignature } from '@/app/weldmail/components/compose-signature';
import type { SignatureMode } from '@/app/weldmail/lib/signature';

/**
 * Pairs each attachment with a stable content-based React key. The same file can
 * be attached twice, so an occurrence counter disambiguates identical keys.
 */
function keyAttachedFiles(files: File[]): Array<{ file: File; key: string }> {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const base = `${file.name}:${file.size}:${file.lastModified}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { file, key: `${base}:${occurrence}` };
  });
}

function attachmentCountLabel(count: number, singular: string, plural: string): string {
  return (count > 1 ? plural : singular).replace('{n}', String(count));
}

/**
 * Deleting all the text leaves a stray `<br>` (or an empty block) in a
 * contentEditable, so it never matches `:empty` again and the placeholder stays
 * hidden. Empty it for real once nothing visible is left.
 */
function clearIfBlank(editor: HTMLElement) {
  if (editor.innerHTML === '' || editor.textContent !== '') return;
  if (editor.querySelector('img, li, hr, table')) return;
  editor.innerHTML = '';
}

// Swatches of the text-colour picker in the formatting bar.
const TEXT_COLORS = ['#111827', '#6b7280', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#9333ea'];

// Placeholders the variable button can insert, in the `{{token}}` form mail templates use.
const COMPOSE_VARIABLES = [
  { token: 'first_name', label: 'firstName' },
  { token: 'last_name', label: 'lastName' },
  { token: 'full_name', label: 'fullName' },
  { token: 'email', label: 'email' },
  { token: 'company', label: 'company' },
] as const;

// Shared look of the small icon buttons (header and footer).
const TOOL_BUTTON =
  'h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';
// Fixed-width label column, so From / To / Subject values line up.
const FIELD_LABEL = 'w-[72px] flex-shrink-0 text-sm text-muted-foreground';
// The recipient suggestions sit under the field, past the label column.
const SUGGESTIONS_MENU = 'left-[72px] w-72';

type MailAccountOption = NonNullable<ReturnType<typeof useMailAccounts>['data']>['data'][number];

function accountDisplayName(account: MailAccountOption): string {
  return account.displayName || account.name || account.email;
}

/** An account's avatar and name, as the From row shows it. */
function FromAccountLabel({ account }: Readonly<{ account: MailAccountOption }>) {
  const name = accountDisplayName(account);
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Avatar className="h-4 w-4 !rounded-[5px] flex-shrink-0">
        <AvatarFallback className="!rounded-[5px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium text-foreground truncate">{name}</span>
    </span>
  );
}

/**
 * "From" row: the sending account's avatar and name. With `onAccountChange` and
 * more than one account it is a picker of the account to send from.
 */
function ComposeFromRow({
  accountId,
  label,
  onAccountChange,
  testId,
}: Readonly<{ accountId?: string; label: string; onAccountChange?: (accountId: string) => void; testId: string }>) {
  const { t } = useI18n();
  const { data: accountsData } = useMailAccounts();
  const accounts = accountsData?.data ?? [];
  const account = accounts.find((a) => a.id === accountId);

  if (onAccountChange && accounts.length > 1) {
    return (
      <div className="flex items-center min-h-9">
        <span className={FIELD_LABEL}>{label}</span>
        <Select value={account?.id ?? ''} onValueChange={onAccountChange}>
          <SelectTrigger
            size="sm"
            aria-label={label}
            title={account?.email}
            className="data-[size=sm]:h-7 w-auto max-w-full min-w-0 gap-1.5 border-0 bg-transparent px-1.5 -ml-1.5 shadow-none hover:bg-muted focus-visible:ring-0 dark:bg-transparent dark:hover:bg-muted"
            data-testid={testId}
          >
            {account ? (
              <FromAccountLabel account={account} />
            ) : (
              <SelectValue placeholder={t.mail.floatingCompose.selectFromAccount} />
            )}
          </SelectTrigger>
          <SelectContent align="start">
            {accounts.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm truncate">{accountDisplayName(option)}</span>
                  {accountDisplayName(option) !== option.email && (
                    <span className="text-xs text-muted-foreground truncate">{option.email}</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="flex items-center min-h-9">
      <span className={FIELD_LABEL}>{label}</span>
      {account && (
        <div className="flex items-center min-w-0" title={account.email}>
          <FromAccountLabel account={account} />
        </div>
      )}
    </div>
  );
}

// How far ahead a send can be scheduled. Keep in step with MAX_SCHEDULE_DAYS in
// apps/workers/mail-api/src/services/mail/scheduled.ts, which rejects anything later.
const MAX_SCHEDULE_DAYS = 365;

// "Oct 20, 9:00 AM", with the year once it is not this year's.
function formatScheduledTime(date: Date): string {
  return format(date, date.getFullYear() === new Date().getFullYear() ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
}

// "Schedule for Oct 20, 9:00 AM" once a time is picked.
function scheduleLabelFor(template: string, scheduledTime: Date | null): string | undefined {
  return scheduledTime ? template.replace('{date}', formatScheduledTime(scheduledTime)) : undefined;
}

// The send button's text: "Send", or "Schedule  Oct 20, 9:00 AM".
function SendButtonLabel({
  scheduledTime,
  scheduleText,
  sendText,
  testId,
}: Readonly<{ scheduledTime: Date | null; scheduleText: string; sendText: string; testId: string }>) {
  if (!scheduledTime) return <>{sendText}</>;
  return (
    <>
      {scheduleText}
      <span className="font-normal opacity-80" data-testid={testId}>
        {formatScheduledTime(scheduledTime)}
      </span>
    </>
  );
}

// Schedule helpers: a picked time never lands in the past.
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

export interface ComposeSurfaceProps {
  /** Frame of the surface: the floating panel's box, or the full page's pane. */
  className?: string;
  style?: React.CSSProperties;
  /** Per-surface tweak of the header row (the full page uses a taller one). */
  headerClassName?: string;
  /** Per-surface tweak of the footer's icon row. */
  toolbarClassName?: string;
  /** Prefix of the `data-testid`s, so two surfaces never share an id. */
  testIdPrefix?: string;
  accountId?: string;
  /** Makes From a picker of the account to send from. */
  onAccountChange?: (accountId: string) => void;

  // Header actions. A button is left out when its handler is.
  onMinimize?: () => void;
  /** The full page hands over to the floating panel: this button opens it, minimize collapses it to its bar. */
  onPopOut?: () => void;
  /** The full page minimizes into the floating panel, which small screens do not have. */
  hideMinimizeOnMobile?: boolean;
  onExpand?: () => void;
  onClose: () => void;
  /** Tooltip of the close button, when closing does more than close (saves a draft). */
  closeTitle?: string;

  // Recipients
  toRecipients: string[];
  setToRecipients: React.Dispatch<React.SetStateAction<string[]>>;
  toInput: string;
  setToInput: (value: string) => void;
  showCc: boolean;
  showBcc: boolean;
  onShowCc: () => void;
  onShowBcc: () => void;
  cc: string;
  bcc: string;
  onCcChange: (value: string) => void;
  onBccChange: (value: string) => void;

  subject: string;
  onSubjectChange: (value: string) => void;

  /** The body editor. The caller writes initial HTML to it and reads it when sending. */
  editorRef: React.RefObject<HTMLDivElement | null>;
  onBodyInput: (html: string, text: string) => void;
  onBodyBlur: (html: string) => void;
  /**
   * Which default signature goes into a blank body once the surface opens; null
   * for none (an opened draft keeps what it had). The picker is there either way.
   */
  signatureMode: SignatureMode | null;

  attachedFiles: File[];
  onAttachedFilesChange: React.Dispatch<React.SetStateAction<File[]>>;

  scheduledTime: Date | null;
  onScheduledTimeChange: (date: Date | null) => void;

  /** Generates content from the prompt; resolves to whether it wrote something. */
  onAiGenerate: (prompt: string) => Promise<boolean>;

  onSend: () => void;
  isSending: boolean;
}

export function ComposeSurface({
  className,
  style,
  headerClassName,
  toolbarClassName,
  testIdPrefix = 'compose',
  accountId,
  onAccountChange,
  onMinimize,
  onPopOut,
  hideMinimizeOnMobile = false,
  onExpand,
  onClose,
  closeTitle,
  toRecipients,
  setToRecipients,
  toInput,
  setToInput,
  showCc,
  showBcc,
  onShowCc,
  onShowBcc,
  cc,
  bcc,
  onCcChange,
  onBccChange,
  subject,
  onSubjectChange,
  editorRef,
  onBodyInput,
  onBodyBlur,
  signatureMode,
  attachedFiles,
  onAttachedFilesChange,
  scheduledTime,
  onScheduledTimeChange,
  onAiGenerate,
  onSend,
  isSending,
}: Readonly<ComposeSurfaceProps>) {
  const { t } = useI18n();
  // The AI bar and its button need `/mail-ai`, which the Kubernetes editions lack.
  const aiAvailable = isFeatureAvailable('mail-ai');
  const signature = useComposeSignature({ editorRef, accountId, autoInsert: signatureMode, onChange: onBodyInput });

  const [fontSize, setFontSize] = useState('14');
  const [showFormatting, setShowFormatting] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  // Formatting states
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isStrikethrough, setIsStrikethrough] = useState(false);

  // AI input states
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const aiInputRef = useRef<HTMLInputElement>(null);


  const [variableMenuOpen, setVariableMenuOpen] = useState(false);

  // Store selection for restoring after toolbar clicks
  const savedSelectionRef = useRef<Range | null>(null);

  // A new compose starts with the cursor in To. When recipients are already
  // there (a reply, a reopened draft) the next thing to write is the body.
  const [startInTo] = useState(() => toRecipients.length === 0);
  // A Cc / Bcc row opened by its button takes the cursor; one that is already
  // there when the surface opens does not.
  const [focusNewRows, setFocusNewRows] = useState(false);
  useEffect(() => {
    if (!startInTo) editorRef.current?.focus();
    setFocusNewRows(true);
    // Once, when the surface opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setIsStrikethrough(isEditorCommandActive('strikeThrough'));
  };

  const focusEditor = () => {
    if (editorRef.current) {
      editorRef.current.focus();
      restoreSelection();
    }
  };

  // Prevent toolbar buttons from stealing focus
  const preventFocusLoss = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const executeCommand = (command: string, value?: string) => {
    if (editorRef.current) {
      editorRef.current.focus();
      restoreSelection();
      runEditorCommand(command, value);
      saveSelection();
    }
  };

  const handleBold = () => { executeCommand('bold'); checkFormatting(); };
  const handleItalic = () => { executeCommand('italic'); checkFormatting(); };
  const handleUnderline = () => { executeCommand('underline'); checkFormatting(); };
  const handleBulletList = () => { executeCommand('insertUnorderedList'); checkFormatting(); };
  const handleNumberedList = () => { executeCommand('insertOrderedList'); checkFormatting(); };
  const handleStrikethrough = () => { executeCommand('strikeThrough'); checkFormatting(); };
  const handleUndo = () => { executeCommand('undo'); checkFormatting(); };
  const handleRedo = () => { executeCommand('redo'); checkFormatting(); };
  const handleTextColor = (color: string) => {
    setColorPickerOpen(false);
    executeCommand('foreColor', color);
    checkFormatting();
  };
  const handleAlign = (command: 'justifyLeft' | 'justifyCenter' | 'justifyRight') => { executeCommand(command); checkFormatting(); };
  const handleIndent = () => { executeCommand('indent'); checkFormatting(); };
  const handleOutdent = () => { executeCommand('outdent'); checkFormatting(); };
  const handleRemoveFormatting = () => { executeCommand('removeFormat'); checkFormatting(); };
  const handleInsertVariable = (token: string) => {
    setVariableMenuOpen(false);
    executeCommand('insertText', `{{${token}}}`);
    checkFormatting();
  };

  // The icon row has one selected button at a time: opening the AI bar closes
  // the formatting bar, and the other way round.
  const handleOpenAiInput = () => {
    setShowFormatting(false);
    setShowAiInput(true);
    setTimeout(() => aiInputRef.current?.focus(), 0);
  };

  const handleCloseAiInput = () => {
    setShowAiInput(false);
    setAiPrompt('');
  };

  const handleToggleFormatting = () => {
    if (isAiGenerating) return;
    if (!showFormatting) handleCloseAiInput();
    setShowFormatting((shown) => !shown);
  };

  const handleAiGenerate = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || isAiGenerating) return;
    setIsAiGenerating(true);
    try {
      if (await onAiGenerate(prompt)) handleCloseAiInput();
    } finally {
      setIsAiGenerating(false);
    }
  };


  // A send without a recipient does not go anywhere: say so next to the To
  // field and put the cursor there.
  const toFieldRef = useRef<RecipientsRowHandle>(null);
  const [recipientMissing, setRecipientMissing] = useState(false);
  const hasRecipient = toRecipients.length > 0 || toInput.trim() !== '';
  useEffect(() => {
    if (hasRecipient) setRecipientMissing(false);
  }, [hasRecipient]);

  const handleSend = () => {
    if (!hasRecipient) {
      setRecipientMissing(true);
      toFieldRef.current?.focus();
      return;
    }
    onSend();
  };

  const scheduleLabel = scheduleLabelFor(t.mail.floatingCompose.scheduleFor, scheduledTime);

  // Ctrl/Cmd+Enter sends from anywhere in the surface.
  const handleSendShortcut = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    handleSend();
  };

  return (
    <div
      className={cn('flex flex-col bg-background', className)}
      style={style}
      role="presentation"
      onKeyDown={handleSendShortcut}
    >
      {/* Header */}
      <div className={cn('flex items-center justify-between gap-3 h-[46px] pl-4 pr-2.5 border-b border-border flex-shrink-0', headerClassName)}>
        <span className="text-sm font-medium text-foreground truncate min-w-0">{t.mail.floatingCompose.title}</span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onMinimize && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(TOOL_BUTTON, hideMinimizeOnMobile && 'hidden md:inline-flex')}
              data-testid={`${testIdPrefix}-minimize-btn`}
              onClick={onMinimize}
              title={t.mail.floatingCompose.minimize}
              aria-label={t.mail.floatingCompose.minimize}
            >
              <Minus className="h-4 w-4" />
            </Button>
          )}
          {onPopOut && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(TOOL_BUTTON, hideMinimizeOnMobile && 'hidden md:inline-flex')}
              data-testid={`${testIdPrefix}-pop-out-btn`}
              onClick={onPopOut}
              title={t.mail.floatingCompose.popOut}
              aria-label={t.mail.floatingCompose.popOut}
            >
              <PictureInPicture2 className="h-4 w-4" />
            </Button>
          )}
          {onExpand && (
            <Button
              variant="ghost"
              size="icon"
              className={TOOL_BUTTON}
              data-testid={`${testIdPrefix}-expand-btn`}
              onClick={onExpand}
              title={t.mail.floatingCompose.expand}
              aria-label={t.mail.floatingCompose.expand}
            >
              <Maximize className="size-[15px]" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={TOOL_BUTTON}
            data-testid={`${testIdPrefix}-close-btn`}
            onClick={onClose}
            title={closeTitle ?? t.mail.floatingCompose.close}
            aria-label={t.mail.floatingCompose.close}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>


      {/* Compose Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-[300px]">
        <div className="bg-background flex-1 flex flex-col overflow-hidden">
          {/* From / To / Cc / Bcc / Subject */}
          <div className="px-4 pt-2 pb-1 flex-shrink-0">
            <ComposeFromRow
              accountId={accountId}
              label={t.mail.floatingCompose.from}
              onAccountChange={onAccountChange}
              testId={`${testIdPrefix}-from-account`}
            />

            {/* To, with the Cc / Bcc buttons at its end. Each reveals its own row and
                disappears once that row is shown. */}
            <RecipientsRow
              label={t.mail.compose.to}
              recipients={toRecipients}
              setRecipients={setToRecipients}
              input={toInput}
              setInput={setToInput}
              labelClassName={FIELD_LABEL}
              menuClassName={SUGGESTIONS_MENU}
              focusOnMount={startInTo}
              testId={`${testIdPrefix}-to-input`}
              handleRef={toFieldRef}
              error={recipientMissing ? t.mail.compose.recipientRequired : undefined}
              trailing={
                (!showCc || !showBcc) && (
                  <div className="flex items-center h-9 -mr-2 flex-shrink-0">
                    {!showCc && (
                      <Button
                        variant="ghost"
                        data-testid={`${testIdPrefix}-cc-toggle`}
                        onClick={onShowCc}
                        className="h-7 px-2 text-sm font-normal text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                      >
                        {t.mail.compose.cc}
                      </Button>
                    )}
                    {!showBcc && (
                      <Button
                        variant="ghost"
                        data-testid={`${testIdPrefix}-bcc-toggle`}
                        onClick={onShowBcc}
                        className="h-7 px-2 text-sm font-normal text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                      >
                        {t.mail.compose.bcc}
                      </Button>
                    )}
                  </div>
                )
              }
            />

            {/* Cc and Bcc: the same chips and suggestions as To */}
            {showCc && (
              <StringRecipientsRow
                label={t.mail.compose.cc}
                value={cc}
                onChange={onCcChange}
                labelClassName={FIELD_LABEL}
                menuClassName={SUGGESTIONS_MENU}
                focusOnMount={focusNewRows}
                testId={`${testIdPrefix}-cc-input`}
              />
            )}
            {showBcc && (
              <StringRecipientsRow
                label={t.mail.compose.bcc}
                value={bcc}
                onChange={onBccChange}
                labelClassName={FIELD_LABEL}
                menuClassName={SUGGESTIONS_MENU}
                focusOnMount={focusNewRows}
                testId={`${testIdPrefix}-bcc-input`}
              />
            )}

            {/* Subject Field */}
            <div className="flex items-center min-h-9">
              <span className={FIELD_LABEL}>{t.mail.compose.subject}</span>
              <input
                type="text"
                aria-label={t.mail.compose.subject}
                placeholder={t.mail.floatingCompose.subjectPlaceholder}
                className="flex-1 min-w-0 text-sm outline-none bg-transparent text-foreground placeholder:text-muted-foreground"
                value={subject}
                onChange={(e) => onSubjectChange(e.target.value)}
              />
            </div>
          </div>

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
              ref={editorRef}
              contentEditable={!isAiGenerating}
              role="textbox"
              tabIndex={isAiGenerating ? -1 : 0}
              aria-multiline="true"
              suppressContentEditableWarning
              aria-label={t.mail.floatingCompose.writePlaceholder}
              data-testid={`${testIdPrefix}-body`}
              data-placeholder={t.mail.floatingCompose.writePlaceholder}
              className={cn(
                "w-full min-h-[150px] px-4 text-sm outline-none bg-transparent text-foreground [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
                MAIL_EDITOR_PARAGRAPH_CLASSES,
                isAiGenerating && "opacity-0"
              )}
              onSelect={checkFormatting}
              onKeyUp={checkFormatting}
              onClick={checkFormatting}
              style={{
                fontSize: `${fontSize}px`,
                textAlign: 'left',
              }}
              onInput={(e) => {
                clearIfBlank(e.currentTarget);
                onBodyInput(e.currentTarget.innerHTML, e.currentTarget.textContent ?? '');
              }}
              onBlur={(e) => {
                onBodyBlur(e.currentTarget.innerHTML);
              }}
            />

            {/* Attached Files */}
            {attachedFiles.length > 0 && (
              <div className="mt-4 mx-4 p-4 bg-muted/50 rounded-lg border border-border">
                <div className="flex items-center gap-2 text-foreground mb-3">
                  <Paperclip className="h-3.5 w-3.5" />
                  <span className="text-sm font-medium">
                    {attachmentCountLabel(attachedFiles.length, t.mail.floatingCompose.attachmentCount, t.mail.floatingCompose.attachmentCountPlural)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {(attachedFiles.reduce((acc, file) => acc + file.size, 0) / 1024).toFixed(2)} KB
                  </span>
                </div>
                <div className="flex items-start gap-3 flex-wrap">
                  {keyAttachedFiles(attachedFiles).map(({ file, key }, index) => {
                    const isImage = file.type.startsWith('image/');
                    const fileExtension = file.name.split('.').pop()?.toUpperCase() || 'FILE';
                    const fileName = file.name.split('.').slice(0, -1).join('.') || file.name;
                    return (
                      <div key={key} className="relative group">
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
                          onClick={() => onAttachedFilesChange((prev) => prev.filter((_, i) => i !== index))}
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
                          onAttachedFilesChange((prev) => [...prev, ...Array.from(e.target.files!)]);
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


      {/* Footer */}
      <div className="border-t border-border flex-shrink-0 relative">
        {/* AI draft bar: toggled by the WeldAgent button, same spot and look as the formatting bar */}
        {aiAvailable && showAiInput && (
          <div className="px-3 pt-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 pl-3 pr-1 py-1">
              <input
                ref={aiInputRef}
                type="text"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && aiPrompt.trim()) {
                    e.preventDefault();
                    void handleAiGenerate();
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
                    void handleAiGenerate();
                  }
                }}
                disabled={!aiPrompt.trim() || isAiGenerating}
                className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-30 transition-opacity"
              >
                {isAiGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        )}
        {/* Formatting bar: toggled by the "Aa" button, shown above the icon row */}
        {showFormatting && (
          <div className="px-3 pt-2">
            <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 px-1 py-1 max-w-full flex-wrap">
              {/* Undo / Redo */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleUndo} className={TOOL_BUTTON} title={t.mail.toolbar.undo} aria-label={t.mail.toolbar.undo}>
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleRedo} className={TOOL_BUTTON} title={t.mail.toolbar.redo} aria-label={t.mail.toolbar.redo}>
                <Redo2 className="h-4 w-4" />
              </Button>
              <div className="w-px h-4 bg-border" />
              {/* Font Size */}
              <Select value={fontSize} onValueChange={(value) => { setFontSize(value); focusEditor(); }}>
                <SelectTrigger className="h-7 data-[size=default]:h-7 w-[56px] text-[13.5px] text-muted-foreground bg-transparent dark:bg-transparent border-0 shadow-none hover:bg-muted px-2 rounded-md focus:ring-0 focus:ring-offset-0 focus:outline-none">
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
              <div className="w-px h-4 bg-border" />
              {/* Text Formatting */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBold} className={cn(TOOL_BUTTON, isBold && "bg-muted text-foreground")} title={t.mail.toolbar.bold}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                  <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleItalic} className={cn(TOOL_BUTTON, isItalic && "bg-muted text-foreground")} title={t.mail.toolbar.italic}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="19" y1="4" x2="10" y2="4" />
                  <line x1="14" y1="20" x2="5" y2="20" />
                  <line x1="15" y1="4" x2="9" y2="20" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleUnderline} className={cn(TOOL_BUTTON, isUnderline && "bg-muted text-foreground")} title={t.mail.toolbar.underline}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
                  <line x1="4" y1="21" x2="20" y2="21" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleStrikethrough} className={cn(TOOL_BUTTON, isStrikethrough && "bg-muted text-foreground")} title={t.mail.toolbar.strikethrough} aria-label={t.mail.toolbar.strikethrough}>
                <Strikethrough className="h-4 w-4" />
              </Button>
              {/* Text colour */}
              <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} className={TOOL_BUTTON} title={t.mail.toolbar.textColor} aria-label={t.mail.toolbar.textColor}>
                    <Baseline className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start" side="top" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <div className="grid grid-cols-4 gap-1.5">
                    {TEXT_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onMouseDown={preventFocusLoss}
                        onClick={() => handleTextColor(color)}
                        className="h-6 w-6 rounded-md border border-border transition-transform hover:scale-110"
                        style={{ backgroundColor: color }}
                        aria-label={color}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <div className="w-px h-4 bg-border" />
              {/* Alignment */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} className={TOOL_BUTTON} title={t.mail.toolbar.align} aria-label={t.mail.toolbar.align}>
                    <AlignLeft className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <DropdownMenuItem onSelect={() => handleAlign('justifyLeft')}>
                    <AlignLeft className="h-4 w-4" />
                    {t.mail.toolbar.alignLeft}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleAlign('justifyCenter')}>
                    <AlignCenter className="h-4 w-4" />
                    {t.mail.toolbar.alignCenter}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleAlign('justifyRight')}>
                    <AlignRight className="h-4 w-4" />
                    {t.mail.toolbar.alignRight}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Lists */}
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleBulletList} className={TOOL_BUTTON} title={t.mail.toolbar.bulletList}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <circle cx="4" cy="6" r="1" fill="currentColor" />
                  <circle cx="4" cy="12" r="1" fill="currentColor" />
                  <circle cx="4" cy="18" r="1" fill="currentColor" />
                </svg>
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleNumberedList} className={TOOL_BUTTON} title={t.mail.toolbar.numberedList}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="10" y1="6" x2="21" y2="6" />
                  <line x1="10" y1="12" x2="21" y2="12" />
                  <line x1="10" y1="18" x2="21" y2="18" />
                  <path d="M4 6h1v4" />
                  <path d="M4 10h2" />
                  <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
                </svg>
              </Button>
              <ComposeLinkButton editorRef={editorRef} className={TOOL_BUTTON} testId={`${testIdPrefix}-link-btn`} />
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleOutdent} className={TOOL_BUTTON} title={t.mail.toolbar.indentLess} aria-label={t.mail.toolbar.indentLess}>
                <IndentDecrease className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleIndent} className={TOOL_BUTTON} title={t.mail.toolbar.indentMore} aria-label={t.mail.toolbar.indentMore}>
                <IndentIncrease className="h-4 w-4" />
              </Button>
              <div className="w-px h-4 bg-border" />
              <Button variant="ghost" size="icon" onMouseDown={preventFocusLoss} onClick={handleRemoveFormatting} className={TOOL_BUTTON} title={t.mail.toolbar.removeFormatting} aria-label={t.mail.toolbar.removeFormatting}>
                <RemoveFormatting className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className={cn('flex items-center justify-between gap-2 px-3 py-2', toolbarClassName)}>
          {/* Editor tools */}
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <Button
              variant="ghost"
              size="icon"
              onMouseDown={preventFocusLoss}
              onClick={handleToggleFormatting}
              className={cn(TOOL_BUTTON, showFormatting && "bg-muted text-foreground")}
              title={t.mail.compose.formatting}
              aria-label={t.mail.compose.formatting}
              aria-pressed={showFormatting}
            >
              <ALargeSmall className="h-4 w-4" />
            </Button>
            <ComposeAttachButton
              className={TOOL_BUTTON}
              icon={ImageIcon}
              title={t.mail.toolbar.attachFile}
              testId={`${testIdPrefix}-attach-input`}
              onFilesSelected={(files) => onAttachedFilesChange((prev) => [...prev, ...files])}
            />
            {/* Variables: inserts a {{placeholder}} at the cursor */}
            <Popover open={variableMenuOpen} onOpenChange={setVariableMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onMouseDown={preventFocusLoss}
                  className={TOOL_BUTTON}
                  title={t.mail.toolbar.insertVariable}
                  aria-label={t.mail.toolbar.insertVariable}
                >
                  <Variable className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-0" align="start" side="top" onCloseAutoFocus={(e) => e.preventDefault()}>
                <Command>
                  <CommandInput placeholder={t.mail.toolbar.searchVariables} />
                  <CommandList>
                    <CommandEmpty>{t.mail.toolbar.noVariablesFound}</CommandEmpty>
                    <CommandGroup>
                      {COMPOSE_VARIABLES.map((variable) => (
                        <CommandItem
                          key={variable.token}
                          value={t.mail.toolbar.variables[variable.label]}
                          keywords={[variable.token]}
                          onSelect={() => handleInsertVariable(variable.token)}
                        >
                          {t.mail.toolbar.variables[variable.label]}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <SignaturePicker
              className={TOOL_BUTTON}
              signatures={signature.signatures}
              getSelectedId={signature.getSelectedId}
              onSelect={signature.select}
              testId={`${testIdPrefix}-signature-btn`}
            />

            {/* Schedule send */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(TOOL_BUTTON, scheduledTime && 'bg-muted text-foreground')}
                  data-testid={`${testIdPrefix}-schedule-btn`}
                  title={scheduleLabel ?? t.mail.floatingCompose.schedule}
                  aria-label={scheduleLabel ?? t.mail.floatingCompose.schedule}
                >
                  <Clock className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start" side="top">
                <Calendar
                  mode="single"
                  selected={scheduledTime || undefined}
                  defaultMonth={scheduledTime ?? undefined}
                  onSelect={(date) => {
                    if (date) onScheduledTimeChange(scheduleForDate(date, scheduledTime));
                  }}
                  disabled={(date) => date < startOfDay(new Date()) || date > addDays(new Date(), MAX_SCHEDULE_DAYS)}
                  startMonth={new Date()}
                  endMonth={addDays(new Date(), MAX_SCHEDULE_DAYS)}
                  autoFocus
                />
                <div className="border-t border-border px-3 py-3">
                  <div className="text-xs font-medium text-muted-foreground mb-2">{t.mail.floatingCompose.time}</div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={String(scheduledTime?.getHours() ?? new Date().getHours())}
                      onValueChange={(value) => onScheduledTimeChange(scheduleWithHour(scheduledTime, value))}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {availableHours(scheduledTime).map((i) => (
                          <SelectItem key={i} value={String(i)}>
                            {i.toString().padStart(2, '0')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-muted-foreground">:</span>
                    <Select
                      value={String(scheduledTime?.getMinutes() ?? Math.min(new Date().getMinutes() + 1, 59))}
                      onValueChange={(value) => onScheduledTimeChange(scheduleWithMinute(scheduledTime, value))}
                    >
                      <SelectTrigger className="w-[70px] h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {availableMinutes(scheduledTime).map((i) => (
                          <SelectItem key={i} value={String(i)}>
                            {i.toString().padStart(2, '0')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {scheduledTime && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onScheduledTimeChange(null)}
                      className="mt-2 -ml-2 h-7 px-2 text-xs text-muted-foreground"
                    >
                      {t.mail.floatingCompose.removeSchedule}
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* AI Assistant */}
            {aiAvailable && (
              <Button
                variant="ghost"
                size="icon"
                onMouseDown={preventFocusLoss}
                onClick={() => !isAiGenerating && (showAiInput ? handleCloseAiInput() : handleOpenAiInput())}
                className={cn(TOOL_BUTTON, showAiInput && "bg-[#8d65ef]/10")}
                title={t.mail.toolbar.aiAssistant}
              >
                <WeldAgentIcon className={cn("h-4 w-4", showAiInput && "text-[#8d65ef]")} />
              </Button>
            )}
          </div>

          {/* Send, or schedule at the chosen time */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              type="button"
              data-testid={`${testIdPrefix}-send-btn`}
              onClick={handleSend}
              disabled={isSending}
              size="sm"
              className="ml-1 !px-3"
              title="Ctrl+Enter"
              aria-label={scheduleLabel}
            >
              {isSending && <Loader2 className="h-4 w-4 animate-spin" />}
              <SendButtonLabel
                scheduledTime={scheduledTime}
                scheduleText={t.mail.floatingCompose.schedule}
                sendText={t.mail.floatingCompose.sendEmail}
                testId={`${testIdPrefix}-scheduled-time`}
              />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
