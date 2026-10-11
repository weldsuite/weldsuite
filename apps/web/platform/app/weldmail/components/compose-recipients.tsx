/**
 * The To field of the mail composer: recipient chips, the typing input, the
 * people suggestions menu and the handlers that tie them together. Shared by
 * the full-page compose and the floating compose panel so both behave the same.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { RecordPickerMenu } from '@/components/objects/_shared/record-picker-menu';
import { useI18n } from '@/lib/i18n/provider';
import { usePersonSearch, type Person } from '@/hooks/queries/use-people-queries';

// A `RecordPickerOption` whose detail line is the person's email address.
interface PersonSuggestion {
  id: string;
  email: string;
  name: string;
  detail: string;
  avatarUrl: string | null;
}

// The subset of a person row the recipient autocomplete needs.
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

const parseRecipientList = (value: string): string[] =>
  value.split(/[,;]/).map((e) => e.trim()).filter((e) => e.length > 0);

// The committed recipients plus whatever is still typed in the To input.
export const withPendingInput = (recipients: string[], input: string): string[] => {
  const pending = input.trim();
  return pending ? [...recipients, pending] : [...recipients];
};

// Enter/Tab (without Ctrl/Cmd) commits the typed recipient.
const isCommitKey = (e: React.KeyboardEvent): boolean =>
  (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey;

// The text before a trailing comma/semicolon, or null when there is none.
const trailingDelimiterBody = (value: string): string | null =>
  (/[,;]$/.test(value) ? value.slice(0, -1).trim() : null);

const toPersonSuggestion = (p: PersonLike): PersonSuggestion => ({
  id: p.id,
  name: p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '',
  email: p.email ?? '',
  detail: p.email ?? '',
  avatarUrl: p.avatarUrl ?? null,
});

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

// Person autocomplete. The menu only opens once something is typed: a focused
// but empty To field shows nothing.
function useContactSuggestions() {
  const [open, setShow] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const show = open && query.trim().length > 0;
  const personSearchResult = usePersonSearch(query, show);
  const isLoading = personSearchResult.isLoading;

  const contacts: PersonSuggestion[] = useMemo(() => {
    const raw: PersonLike[] = personSearchResult.data?.data ?? [];
    return raw.map(toPersonSuggestion);
  }, [personSearchResult.data]);

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

  // `refocus: false` is for the commit that happens because the field lost
  // focus: pulling the cursor back would take it away from where the user went.
  const addRecipient = (email: string, { refocus = true }: { refocus?: boolean } = {}) => {
    // A pasted list ("a@x.nl, b@y.nl") becomes one chip per address.
    const added = parseRecipientList(email);
    if (added.length > 0) {
      setToRecipients((prev) => [...prev, ...added.filter((a, i) => !prev.includes(a) && added.indexOf(a) === i)]);
    }
    setToInput('');
    suggestions.setQuery('');
    suggestions.setShow(false);
    if (refocus) suggestions.inputRef.current?.focus();
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
        addRecipient(toInput, { refocus: false });
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

function ToRecipientsInput({
  recipients,
  input,
  inputRef,
  onRemoveRecipient,
  onInputChange,
  onInputKeyDown,
  onInputFocus,
  onInputBlur,
  label,
  testId,
}: Readonly<{
  recipients: string[];
  input: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onRemoveRecipient: (email: string) => void;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
  /** Accessible name of the typing input (To, Cc, Bcc). */
  label: string;
  testId?: string;
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
        aria-label={label}
        data-testid={testId}
      />
    </div>
  );
}

function ContactSuggestionsList({
  containerRef,
  isLoading,
  contacts,
  toRecipients,
  onSelect,
  onCreatePerson,
  className,
}: Readonly<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  isLoading: boolean;
  contacts: PersonSuggestion[];
  toRecipients: string[];
  onSelect: (contact: PersonSuggestion) => void;
  onCreatePerson: () => void;
  /** Overrides the default position/width (below the field, full width up to `max-w-sm`). */
  className?: string;
}>) {
  const { t } = useI18n();
  const available = contacts.filter((c) => !toRecipients.includes(c.email));

  // The search runs server-side and the text input lives outside the menu;
  // mousedown is swallowed to keep the input focused.
  return (
    <div
      ref={containerRef}
      role="presentation"
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'absolute left-0 top-full mt-1 w-full max-w-sm bg-popover text-popover-foreground border rounded-md shadow-md z-50 overflow-hidden',
        className,
      )}
    >
      <RecordPickerMenu
        options={available}
        isLoading={isLoading}
        loadingLabel={t.mail.composePage.loadingContacts}
        onSelect={onSelect}
        createLabel={t.mail.composePage.createNewPerson}
        onCreate={onCreatePerson}
      />
    </div>
  );
}

/**
 * One recipients row (To, Cc or Bcc): the label, the chips with their typing
 * input, the people suggestions menu under it and the quick-add dialog.
 */
export function RecipientsRow({
  label,
  recipients,
  setRecipients,
  input,
  setInput,
  labelClassName,
  menuClassName,
  trailing,
  focusOnMount = false,
  testId,
}: Readonly<{
  label: string;
  recipients: string[];
  setRecipients: React.Dispatch<React.SetStateAction<string[]>>;
  input: string;
  setInput: (value: string) => void;
  labelClassName?: string;
  /** Position/width of the suggestions menu (it sits under the field, past the label). */
  menuClassName?: string;
  /** Rendered at the end of the row (the Cc / Bcc buttons on the To row). */
  trailing?: React.ReactNode;
  focusOnMount?: boolean;
  testId?: string;
}>) {
  const suggestions = useContactSuggestions();
  const recipientInput = useRecipientInput({
    toRecipients: recipients,
    setToRecipients: setRecipients,
    toInput: input,
    setToInput: setInput,
    suggestions,
  });

  const { inputRef } = suggestions;
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
    // Once, when the row appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="relative">
        <div className="flex items-start min-h-9">
          {/* `leading-9` goes last: a text-size class in `labelClassName` would otherwise
              reset the line height and leave the label above the field's centre line. */}
          <span className={cn(labelClassName, 'leading-9')}>{label}</span>
          <div className="flex flex-1 min-w-0 py-[5px]">
            <ToRecipientsInput
              recipients={recipients}
              input={input}
              inputRef={inputRef}
              onRemoveRecipient={recipientInput.removeRecipient}
              onInputChange={recipientInput.handleToInputChange}
              onInputKeyDown={recipientInput.handleToInputKeyDown}
              onInputFocus={recipientInput.handleToInputFocus}
              onInputBlur={recipientInput.handleToInputBlur}
              label={label}
              testId={testId}
            />
          </div>
          {trailing}
        </div>

        {suggestions.show && (
          <ContactSuggestionsList
            className={menuClassName}
            containerRef={suggestions.containerRef}
            isLoading={suggestions.isLoading}
            contacts={suggestions.contacts}
            toRecipients={recipients}
            onSelect={(contact) => recipientInput.addRecipient(contact.email)}
            onCreatePerson={recipientInput.handleCreatePerson}
          />
        )}
      </div>

      <QuickAddPersonDialog
        open={recipientInput.createPersonQuery !== null}
        onOpenChange={(open) => {
          if (!open) recipientInput.setCreatePersonQuery(null);
        }}
        initialName={recipientInput.createPersonQuery ?? ''}
        onCreated={recipientInput.handlePersonCreated}
      />
    </>
  );
}

/**
 * A recipients row over a comma-separated string, which is how Cc and Bcc are
 * kept by the compose surfaces. The string always holds the chips plus whatever
 * is still being typed, so sending or saving never misses an uncommitted address.
 */
export function StringRecipientsRow({
  value,
  onChange,
  ...row
}: Readonly<
  { value: string; onChange: (value: string) => void } & Omit<
    React.ComponentProps<typeof RecipientsRow>,
    'recipients' | 'setRecipients' | 'input' | 'setInput'
  >
>) {
  const [model, setModel] = useState(() => ({ recipients: parseRecipientList(value), input: '' }));
  const joined = withPendingInput(model.recipients, model.input).join(', ');
  // The string both sides last agreed on: an edit here is pushed out once, and
  // only a change that did not come from here (a loaded draft, a hand-over from
  // the other compose surface) is taken in.
  const syncedRef = useRef(value);

  useEffect(() => {
    if (value === syncedRef.current) return;
    syncedRef.current = value;
    setModel({ recipients: parseRecipientList(value), input: '' });
  }, [value]);

  useEffect(() => {
    if (joined === syncedRef.current) return;
    syncedRef.current = joined;
    onChange(joined);
  }, [joined, onChange]);

  return (
    <RecipientsRow
      {...row}
      recipients={model.recipients}
      setRecipients={(action) =>
        setModel((m) => ({ ...m, recipients: typeof action === 'function' ? action(m.recipients) : action }))
      }
      input={model.input}
      setInput={(next) => setModel((m) => ({ ...m, input: next }))}
    />
  );
}
