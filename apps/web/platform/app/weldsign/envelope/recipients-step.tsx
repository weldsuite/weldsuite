/**
 * Who signs and who gets a copy, in the request's side panel.
 *
 * "Add recipient" first asks who: a contact from the CRM, a teammate, or
 * someone new, who goes into the CRM as a contact. Then it asks how:
 * their role, language and identity check. Added, they become a standard list
 * row (name, email, role, and language and identity check where the list is
 * wide enough); clicking it, or Edit in its menu, turns it back into the form.
 *
 * "Access code" needs its code: the server refuses that mode without one, so
 * the form does too.
 */

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, Plus, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@weldsuite/ui/components/command';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  SIGN_AUTH_MODES,
  SIGN_LOCALES,
  SIGN_RECIPIENT_ROLES,
  type CreateSignRecipientInput,
  type SignAuthMode,
  type SignEnvelopeDetail,
  type SignLocale,
  type SignRecipientDto,
  type SignRecipientRole,
  type UpdateSignRecipientInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { personSeedFromQuery } from '@/app/weldcrm/people/lib/person-seed';
import { useCreatePerson, usePersonSearch, type Person, type PersonSummary } from '@/components/objects/person/use-person-data';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  targetOf,
  useSignRecipientMutations,
  useSignRecipientSuggestions,
  useUpdateSignEnvelope,
} from '@/hooks/queries/use-weldsign-queries';
import { ChoiceField } from '../components/choice-field';
import { recipientColor, type RecipientColor } from '../lib/recipient-colors';
import { apiErrorMessage } from '../lib/errors';
import { PANEL_ROW } from './editor-frame';
import { SigningOrderToggle } from './settings-fields';

const emailSchema = z.string().trim().email();

/** How many contacts and teammates the search offers at a time. */
const MAX_OPTIONS = 6;

export function RecipientsStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const updateEnvelope = useUpdateSignEnvelope(targetOf(envelope));
  const mutations = useSignRecipientMutations(envelope.id);
  const recipients = envelope.recipientList;
  // An order only means something with two people or more: the switch, the
  // numbers and the moves show from then on.
  const canOrder = recipients.length > 1;
  const ordered = canOrder && envelope.signingOrderEnabled;
  const [editingId, setEditingId] = useState<string | null>(null);

  const swap = (a: SignRecipientDto, b: SignRecipientDto) => {
    mutations.update.mutate({ recipientId: a.id, input: { routingOrder: b.routingOrder } });
    mutations.update.mutate({ recipientId: b.id, input: { routingOrder: a.routingOrder } });
  };

  /** Saves what the edit form changed, then shows the row again. */
  const saveEdit = (recipient: SignRecipientDto, values: RecipientValues) => {
    const input = changes(recipient, values);
    if (Object.keys(input).length === 0) return setEditingId(null);
    mutations.update.mutate(
      { recipientId: recipient.id, input },
      {
        onSuccess: () => setEditingId(null),
        onError: (err) => toast.error(`${format(tr.saveFailed, { name: recipient.name ?? '' })}: ${apiErrorMessage(err)}`),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {canOrder && (
        <SigningOrderToggle
          checked={ordered}
          disabled={!editable}
          plain
          onChange={(signingOrderEnabled) => updateEnvelope.mutate({ signingOrderEnabled })}
        />
      )}

      {editable && <SuggestedRecipients envelope={envelope} />}

      {/* The list runs the full width of the panel, past the section's padding, and ends on a divider
          like its rows. While someone is edited the column header is gone, so a divider opens it too. */}
      {recipients.length > 0 && (
        <div className={cn('-mx-5 border-b border-gray-200/70 dark:border-border', editingId && 'border-t')}>
          <TabListScope>
            <EntityList<SignRecipientDto>
              items={recipients}
              isLoading={false}
              // While someone is edited their form stands in the list, without the column header.
              headerColumns={editingId ? undefined : recipientColumns(tr)}
              filters={[]}
              hideTopBar
              renderRow={(recipient) => {
                const i = recipients.indexOf(recipient);
                if (editingId === recipient.id) {
                  return (
                    <div key={recipient.id} className="border-b border-gray-200/70 px-4 py-3 dark:border-border">
                      <RecipientForm
                        initial={valuesOf(recipient)}
                        color={recipientColor(i)}
                        heading
                        hasAccessCode={recipient.hasAccessCode}
                        submitLabel={t.common.actions.save}
                        busy={mutations.update.isPending}
                        onSubmit={(values) => saveEdit(recipient, values)}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                  );
                }
                return (
                  <RecipientRow
                    key={recipient.id}
                    recipient={recipient}
                    color={recipientColor(i)}
                    position={ordered ? i + 1 : null}
                    editable={editable}
                    onEdit={() => setEditingId(recipient.id)}
                    onRemove={() => mutations.remove.mutate(recipient.id)}
                    onMoveUp={ordered && i > 0 ? () => swap(recipient, recipients[i - 1]!) : undefined}
                    onMoveDown={ordered && i < recipients.length - 1 ? () => swap(recipient, recipients[i + 1]!) : undefined}
                  />
                );
              }}
            />
          </TabListScope>
        </div>
      )}

      {editable ? <AddRecipient envelope={envelope} /> : recipients.length === 0 && <p className="text-sm text-muted-foreground">{tr.empty}</p>}
    </div>
  );
}

/** What the recipient form edits. The access code is only ever typed, never shown. */
interface RecipientValues {
  name: string;
  email: string;
  role: SignRecipientRole;
  locale: SignLocale;
  authMode: SignAuthMode;
  accessCode: string;
}

const valuesOf = (recipient: SignRecipientDto): RecipientValues => ({
  name: recipient.name ?? '',
  email: recipient.email ?? '',
  role: recipient.role,
  locale: recipient.locale,
  authMode: recipient.authMode,
  accessCode: '',
});

/** Only someone who signs has an identity check; anyone else is sent the link. */
const authModeOf = (values: RecipientValues): SignAuthMode => (values.role === 'signer' ? values.authMode : 'link');

/** The fields the edit form changed, ready to save. */
function changes(recipient: SignRecipientDto, values: RecipientValues): UpdateSignRecipientInput {
  const input: UpdateSignRecipientInput = {};
  if (values.name !== (recipient.name ?? '')) input.name = values.name;
  if (values.email !== (recipient.email ?? '')) input.email = values.email;
  if (values.role !== recipient.role) input.role = values.role;
  if (values.locale !== recipient.locale) input.locale = values.locale;
  const authMode = authModeOf(values);
  if (authMode !== recipient.authMode) input.authMode = authMode;
  if (authMode === 'access_code' && values.accessCode) {
    input.authMode = authMode;
    input.accessCode = values.accessCode;
  }
  return input;
}

/**
 * The people on the CRM record the draft started from (a company's people, the
 * person themself, an opportunity's contacts), one click each to add them as a
 * signer. Those already on the draft are left out, matched by email. Nothing is
 * shown without a CRM source, without suggestions, or when they can not be read.
 */
function SuggestedRecipients({ envelope }: Readonly<{ envelope: SignEnvelopeDetail }>) {
  const { t, format, language } = useI18n();
  const ts = t.weldsign.editor.recipients.suggestions;
  const source = envelope.source ?? null;
  const fromCrm = source !== null && source.entityType !== 'file';
  const { data } = useSignRecipientSuggestions(envelope.id, fromCrm);
  const { add } = useSignRecipientMutations(envelope.id);

  const taken = new Set(envelope.recipientList.map((recipient) => recipient.email?.toLowerCase()));
  const suggestions = (data ?? []).filter((person) => !taken.has(person.email.toLowerCase()));
  if (!source?.name || suggestions.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-label={format(ts.title, { name: source.name })}>
      <h3 className="text-sm font-medium">{format(ts.title, { name: source.name })}</h3>
      <ul className="flex flex-wrap gap-2">
        {suggestions.map((person) => (
          <li key={person.personId} className="max-w-full">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-full"
              disabled={add.isPending}
              title={[format(ts.add, { name: person.name }), person.title].filter(Boolean).join(' · ')}
              onClick={() =>
                add.mutate(
                  { name: person.name, email: person.email, role: 'signer', locale: language === 'nl' ? 'nl' : 'en', personId: person.personId },
                  { onError: (err) => toast.error(apiErrorMessage(err)) },
                )
              }
            >
              <UserPlus />
              <span className="truncate">{person.name}</span>
              <span className="truncate font-normal text-muted-foreground">{person.email}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A recipient's initial on their colour, the colour their fields have on the pages. */
function RecipientAvatar({ label, color, small = false }: Readonly<{ label: string; color: RecipientColor; small?: boolean }>) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-medium',
        small ? 'size-[18px] rounded-[6px] text-[9px]' : 'size-6 rounded-[8px] text-xs',
      )}
      style={{ background: color.fill, color: color.border }}
    >
      {(label.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

const labelOf = (recipient: SignRecipientDto) => recipient.name || recipient.email || '';

/** The list's columns. Language and identity check show when the list is wide enough for them. */
const COLUMN = {
  name: 'min-w-0 flex-1',
  email: 'w-[200px] @max-[560px]:w-[150px]',
  role: 'w-[110px]',
  language: 'w-[90px] @max-[760px]:hidden',
  check: 'w-[150px] @max-[760px]:hidden',
};

type RecipientStrings = ReturnType<typeof useI18n>['t']['weldsign']['editor']['recipients'];

function recipientColumns(tr: RecipientStrings): HeaderColumn[] {
  return [
    { id: 'name', header: tr.name, width: COLUMN.name },
    { id: 'email', header: tr.email, width: COLUMN.email },
    { id: 'role', header: tr.role, width: COLUMN.role },
    { id: 'language', header: tr.language, width: COLUMN.language },
    { id: 'check', header: tr.verification, width: COLUMN.check },
  ];
}

function Cell({ className, children }: Readonly<{ className: string; children?: ReactNode }>) {
  return (
    <div className={cn(className, 'min-w-0')}>
      <span className="block truncate text-sm text-muted-foreground">{children || '—'}</span>
    </div>
  );
}

interface RecipientRowProps {
  recipient: SignRecipientDto;
  color: RecipientColor;
  /** The place in the signing order, when there is one. */
  position: number | null;
  editable: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/** One person: a standard list row that opens the edit form, with a menu to edit, move or remove them. */
function RecipientRow({ recipient, color, position, editable, onEdit, onRemove, onMoveUp, onMoveDown }: Readonly<RecipientRowProps>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const td = t.weldsign.editor.documents;
  const label = labelOf(recipient);
  const signer = recipient.role === 'signer';

  const menu = editable ? (
    <>
      <DropdownMenuItem onSelect={onEdit}>{t.common.actions.edit}</DropdownMenuItem>
      {position !== null && (
        <>
          <DropdownMenuItem disabled={!onMoveUp} onSelect={onMoveUp}>
            {td.moveUp}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!onMoveDown} onSelect={onMoveDown}>
            {td.moveDown}
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive" onSelect={onRemove}>
        {tr.remove}
      </DropdownMenuItem>
    </>
  ) : undefined;

  return (
    <TabListRow
      label={label}
      onOpen={editable ? onEdit : undefined}
      menuLabel={format(tr.actions, { name: label })}
      menu={menu}
      className={PANEL_ROW}
    >
      <div className={cn(COLUMN.name, 'flex items-center gap-2')}>
        {position !== null && (
          <span className="w-3 shrink-0 text-right text-xs tabular-nums text-muted-foreground" aria-label={tr.order}>
            {position}
          </span>
        )}
        <RecipientAvatar label={label} color={color} small />
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        {/* A request made from a template keeps the role each person fills. */}
        {recipient.roleName && (
          <Badge variant="secondary" className="shrink-0" title={format(tr.templateRole, { role: recipient.roleName })}>
            {recipient.roleName}
          </Badge>
        )}
      </div>
      <Cell className={COLUMN.email}>{recipient.email}</Cell>
      <Cell className={COLUMN.role}>{tr.roles[recipient.role]}</Cell>
      <Cell className={COLUMN.language}>{tr.languages[recipient.locale]}</Cell>
      {/* Someone who only gets a copy has no identity check. */}
      <Cell className={COLUMN.check}>{signer ? tr.authModes[recipient.authMode] : null}</Cell>
    </TabListRow>
  );
}

interface RecipientFormProps {
  initial: RecipientValues;
  color: RecipientColor;
  /** Picked from the contacts or teammates: who they are is shown, not typed. */
  picked?: boolean;
  /** Who is edited, their avatar and name, above the fields. */
  heading?: boolean;
  /** The signer has an access code already, so a new one is optional. */
  hasAccessCode?: boolean;
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: RecipientValues) => void;
  onCancel: () => void;
}

/** Who (unless picked) and how: role, language, identity check and, for an access code, the code. */
function RecipientForm({ initial, color, picked = false, heading = false, hasAccessCode = false, submitLabel, busy, onSubmit, onCancel }: Readonly<RecipientFormProps>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const id = useId();
  const [values, setValues] = useState(initial);
  const set = <K extends keyof RecipientValues>(key: K, value: RecipientValues[K]) => setValues((prev) => ({ ...prev, [key]: value }));
  const signer = values.role === 'signer';
  const asksCode = signer && values.authMode === 'access_code';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = values.name.trim();
    if (!name) return void toast.error(tr.nameRequired);
    const email = emailSchema.safeParse(values.email);
    if (!email.success) return void toast.error(tr.invalidEmail);
    const accessCode = values.accessCode.trim();
    if (asksCode && !hasAccessCode && accessCode.length < 4) return void toast.error(tr.accessCodeRequired);
    onSubmit({ ...values, name, email: email.data.toLowerCase(), accessCode: asksCode ? accessCode : '' });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {picked ? (
        <div className="flex items-center gap-3">
          <RecipientAvatar label={values.name || values.email} color={color} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{values.name}</p>
            <p className="truncate text-xs text-muted-foreground">{values.email}</p>
          </div>
        </div>
      ) : (
        <>
          {heading && (
            <div className="flex min-w-0 items-center gap-2">
              <RecipientAvatar label={initial.name || initial.email} color={color} />
              <p className="min-w-0 flex-1 truncate text-sm font-medium">{initial.name || initial.email}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-my-1 -mr-1.5 size-7 text-muted-foreground"
                aria-label={t.common.actions.close}
                title={t.common.actions.close}
                onClick={onCancel}
              >
                <X />
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{tr.name}</Label>
              <Input id={`${id}-name`} value={values.name} autoFocus={!initial.name} onChange={(e) => set('name', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-email`}>{tr.email}</Label>
              <Input
                id={`${id}-email`}
                type="email"
                value={values.email}
                autoFocus={!!initial.name && !initial.email}
                onChange={(e) => set('email', e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label={tr.role}
          value={values.role}
          options={SIGN_RECIPIENT_ROLES.map((value) => ({ value, label: tr.roles[value] }))}
          disabled={false}
          onChange={(role) => set('role', role)}
        />
        <ChoiceField
          label={tr.language}
          value={values.locale}
          options={SIGN_LOCALES.map((value) => ({ value, label: tr.languages[value] }))}
          disabled={false}
          onChange={(locale) => set('locale', locale)}
        />
        {signer && (
          <ChoiceField
            label={tr.verification}
            value={values.authMode}
            options={SIGN_AUTH_MODES.map((value) => ({ value, label: tr.authModes[value] }))}
            disabled={false}
            onChange={(authMode) => set('authMode', authMode)}
          />
        )}
      </div>

      {asksCode && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-code`}>{tr.accessCode}</Label>
          <Input
            id={`${id}-code`}
            value={values.accessCode}
            minLength={4}
            maxLength={64}
            autoComplete="off"
            placeholder={hasAccessCode ? '••••••' : ''}
            onChange={(e) => set('accessCode', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{hasAccessCode ? tr.accessCodeSet : tr.accessCodeHint}</p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t.common.actions.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Someone the search offers. `personId` links a CRM contact. */
interface Candidate {
  key: string;
  name: string;
  email: string;
  personId: string | null;
}

/** Who the add form is for: picked from the search, or someone new (`picked` false). */
interface Draft {
  name: string;
  email: string;
  personId: string | null;
  picked: boolean;
}

const personName = (person: Person) =>
  person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email || '';

/** Who "New recipient" starts with: the search, read as a name, an email or "Name <email>". */
function newDraft(query: string): Draft {
  const seed = personSeedFromQuery(query);
  return { name: [seed.firstName, seed.lastName].filter(Boolean).join(' '), email: seed.email, personId: null, picked: false };
}

/**
 * The CRM contact someone new is linked to: the contact that has their email
 * already (with `people:read`), else a new one (with `people:create`), else
 * none. Rejects when the CRM refuses the new contact, having said why.
 */
function useContactFor() {
  const { getClient } = useAppApiClient();
  const createPerson = useCreatePerson();
  const canReadPeople = useCan('people:read');
  const canCreatePeople = useCan('people:create');
  return async (name: string, email: string): Promise<string | null> => {
    if (canReadPeople) {
      const client = await getClient();
      const found = await client
        .post<{ data: PersonSummary[] }>('/people/resolve-by-emails', { emails: [email] })
        .catch(() => null);
      const existing = found?.data.find((person) => person.email?.toLowerCase() === email);
      if (existing) return existing.id;
    }
    if (!canCreatePeople) return null;
    const { firstName, lastName } = personSeedFromQuery(name);
    const created = await createPerson.mutateAsync({ firstName, lastName, email });
    return created?.data?.id ?? null;
  };
}

/**
 * "Add recipient". First who: a search over the CRM's contacts (with
 * `people:read`) and the workspace's teammates, leaving out whoever is on the
 * request already, or "New recipient" for anyone else. Then how, in the
 * recipient form. Someone new is put in the CRM (or linked to the contact
 * with their email) before they are added.
 */
function AddRecipient({ envelope }: Readonly<{ envelope: SignEnvelopeDetail }>) {
  const { t, format, language } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const { add } = useSignRecipientMutations(envelope.id);
  const contactFor = useContactFor();
  const canReadPeople = useCan('people:read');
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const search = query.trim();
  const people = usePersonSearch(search, open && canReadPeople);
  const members = useWorkspaceMembers(1, 100, open);
  const locale: SignLocale = language === 'nl' ? 'nl' : 'en';

  const taken = new Set(envelope.recipientList.map((recipient) => recipient.email?.toLowerCase()));
  const offer = (list: Candidate[]) =>
    list.filter((candidate) => {
      if (!candidate.email || taken.has(candidate.email)) return false;
      taken.add(candidate.email);
      return true;
    });

  const contacts = offer(
    (people.data?.data ?? []).map((person) => ({
      key: `person-${person.id}`,
      name: personName(person),
      email: person.email?.trim().toLowerCase() ?? '',
      personId: person.id,
    })),
  ).slice(0, MAX_OPTIONS);
  const needle = search.toLowerCase();
  const teammates = offer(
    (members.data?.data ?? [])
      .map((member) => ({
        key: `member-${member.userId}`,
        name: member.name || member.email || '',
        email: member.email?.trim().toLowerCase() ?? '',
        personId: null,
      }))
      .filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.email.includes(needle)),
  ).slice(0, MAX_OPTIONS);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (next: Draft) => {
    setDraft(next);
    close();
  };

  const submit = async (values: RecipientValues) => {
    let personId = draft?.personId ?? null;
    if (draft && !draft.picked) {
      setLinking(true);
      try {
        personId = await contactFor(values.name, values.email);
      } catch {
        return; // The CRM said why.
      } finally {
        setLinking(false);
      }
    }
    const authMode = authModeOf(values);
    const input: CreateSignRecipientInput = { name: values.name, email: values.email, role: values.role, locale: values.locale, authMode, personId };
    if (authMode === 'access_code') input.accessCode = values.accessCode;
    add.mutate(input, { onSuccess: () => setDraft(null), onError: (err) => toast.error(apiErrorMessage(err)) });
  };

  if (draft) {
    return (
      <div className="rounded-lg border p-3">
        <RecipientForm
          initial={{ name: draft.name, email: draft.email, role: 'signer', locale, authMode: 'link', accessCode: '' }}
          color={recipientColor(envelope.recipientList.length)}
          picked={draft.picked}
          submitLabel={t.common.actions.add}
          busy={add.isPending || linking}
          onSubmit={(values) => void submit(values)}
          onCancel={() => setDraft(null)}
        />
      </div>
    );
  }

  const pick = (candidate: Candidate) => choose({ name: candidate.name, email: candidate.email, personId: candidate.personId, picked: true });

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 self-start">
          <Plus />
          {tr.add}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={canReadPeople ? tr.search : tr.searchTeammates} />
          <CommandList>
            {contacts.length > 0 && (
              <CommandGroup heading={tr.contacts}>
                {contacts.map((candidate) => (
                  <CandidateItem key={candidate.key} candidate={candidate} onSelect={() => pick(candidate)} />
                ))}
              </CommandGroup>
            )}
            {teammates.length > 0 && (
              <CommandGroup heading={tr.teammates}>
                {teammates.map((candidate) => (
                  <CandidateItem key={candidate.key} candidate={candidate} onSelect={() => pick(candidate)} />
                ))}
              </CommandGroup>
            )}
            {(contacts.length > 0 || teammates.length > 0) && <CommandSeparator />}
            <CommandGroup>
              <CommandItem value="new-recipient" onSelect={() => choose(newDraft(search))}>
                <UserPlus />
                <span className="truncate">{search ? format(tr.newNamed, { query: search }) : tr.newRecipient}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CandidateItem({ candidate, onSelect }: Readonly<{ candidate: Candidate; onSelect: () => void }>) {
  return (
    <CommandItem value={candidate.key} onSelect={onSelect}>
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-[8px] bg-gray-200 text-xs font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground"
      >
        {(candidate.name.trim()[0] ?? '?').toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{candidate.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{candidate.email}</span>
      </span>
    </CommandItem>
  );
}
