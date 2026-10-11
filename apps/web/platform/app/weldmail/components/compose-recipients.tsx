/**
 * The To field of the mail composer: the added recipients, the typing input, the
 * people suggestions menu and the handlers that tie them together. Shared by
 * the full-page compose and the floating compose panel so both behave the same.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, PanelRight, User, X } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useObjectPanel } from '@/components/object-panel';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { RecordPickerMenu } from '@/components/objects/_shared/record-picker-menu';
import { useI18n } from '@/lib/i18n/provider';
import { usePeopleByEmails, usePersonSearch, type Person } from '@/hooks/queries/use-people-queries';

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

// Fades out the end of the address where the chevron sits while the pill shows.
// Written out per variant: Tailwind only picks up class names it can read whole.
const RECIPIENT_FADE = [
  'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-64px),transparent_calc(100%-18px))]',
  'group-focus:[mask-image:linear-gradient(to_right,black_calc(100%-64px),transparent_calc(100%-18px))]',
  'group-data-[state=open]:[mask-image:linear-gradient(to_right,black_calc(100%-64px),transparent_calc(100%-18px))]',
].join(' ');

// Recipients are plain addresses; this is the person an address belongs to.
type RecipientPeople = Record<string, { id: string; avatarUrl: string | null }>;

const personKey = (email: string) => email.trim().toLowerCase();

/**
 * The people behind the recipients: those picked from the suggestions are known
 * at once, typed or restored addresses are looked up. Kept per address so a
 * recipient's avatar does not blink when another one is added.
 */
function useRecipientPeople(recipients: string[]) {
  const [people, setPeople] = useState<RecipientPeople>({});

  const rememberPerson = (email: string, person: { id: string; avatarUrl: string | null }) => {
    setPeople((prev) => ({ ...prev, [personKey(email)]: { id: person.id, avatarUrl: person.avatarUrl } }));
  };

  const unknown = recipients.filter((email) => isCompleteEmail(email) && !people[personKey(email)]);
  const resolved = usePeopleByEmails(unknown).data?.data;
  useEffect(() => {
    const found = (resolved ?? []).filter((person) => person.email);
    if (found.length === 0) return;
    setPeople((prev) => ({
      ...prev,
      ...Object.fromEntries(
        found.map((person) => [personKey(person.email ?? ''), { id: person.id, avatarUrl: person.avatarUrl }]),
      ),
    }));
  }, [resolved]);

  return { people, rememberPerson };
}

function RecipientAvatar({
  avatarUrl,
  name,
  compact = false,
}: Readonly<{
  avatarUrl?: string | null;
  name: string;
  /** 16px instead of 20px, for the recipients in the field itself. */
  compact?: boolean;
}>) {
  const radius = compact ? '!rounded-[5px]' : '!rounded-[7px]';
  return (
    <Avatar className={cn('flex-shrink-0', compact ? 'h-4 w-4' : 'h-5 w-5', radius)}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt={name} className={radius} />}
      <AvatarFallback className={cn('bg-gray-200 dark:bg-muted-foreground/25', radius)}>
        <User className="size-2.5" />
      </AvatarFallback>
    </Avatar>
  );
}

function ToRecipientsInput({
  recipients,
  people,
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
  /** The person behind an address, where there is one. */
  people: RecipientPeople;
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

  const { open: openObjectPanel } = useObjectPanel();

  return (
    <div
      role="presentation"
      className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 min-h-[26px] cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {/* Plain avatar and address at rest. Hovering (or selecting) one shows the pill with a
          chevron over the faded end of the address; clicking opens its menu, and Backspace
          or Delete removes the selected one. */}
      {recipients.map((email) => (
        <DropdownMenu key={email}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key !== 'Backspace' && e.key !== 'Delete') return;
                e.preventDefault();
                onRemoveRecipient(email);
              }}
              className="group relative inline-flex items-center gap-1.5 h-[26px] max-w-full -ml-[5px] pl-1 pr-1.5 rounded-md border border-transparent text-sm text-gray-700 dark:text-foreground outline-none cursor-pointer hover:bg-gray-50 hover:border-gray-200 focus:bg-gray-50 focus:border-gray-200 data-[state=open]:bg-gray-50 data-[state=open]:border-gray-200 dark:hover:bg-accent/40 dark:hover:border-border/50 dark:focus:bg-accent/40 dark:focus:border-border/50 dark:data-[state=open]:bg-accent/40 dark:data-[state=open]:border-border/50"
            >
              <RecipientAvatar avatarUrl={people[personKey(email)]?.avatarUrl} name={email} compact />
              <span className={cn('truncate', RECIPIENT_FADE)}>{email}</span>
              <ChevronDown
                aria-hidden="true"
                className="absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus:opacity-100 group-data-[state=open]:opacity-100"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              // Back to typing, not to a recipient that may just have been removed.
              e.preventDefault();
              inputRef.current?.focus();
            }}
          >
            {people[personKey(email)] && (
              <>
                <DropdownMenuItem
                  onSelect={() => openObjectPanel({ type: 'person', id: people[personKey(email)].id })}
                >
                  <PanelRight />
                  {t.mail.composePage.openRecipientDetails}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => onRemoveRecipient(email)}>
              <X />
              {t.mail.composePage.removeRecipient}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
 * One recipients row (To, Cc or Bcc): the label, the recipients with their typing
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

  const { people, rememberPerson } = useRecipientPeople(recipients);
  const selectContact = (contact: PersonSuggestion) => {
    rememberPerson(contact.email, contact);
    recipientInput.addRecipient(contact.email);
  };

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
              people={people}
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
            onSelect={selectContact}
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
