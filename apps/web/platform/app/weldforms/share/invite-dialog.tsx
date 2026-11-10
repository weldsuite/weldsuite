/**
 * Invite people by email: workspace members, CRM people, a CRM list or pasted
 * addresses (up to 500 per batch), with a subject, a message, a language and
 * reminders. The outbound guard checks the whole batch first: a refusal sends
 * nothing and its message is shown here.
 */

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import {
  FORM_LIMITS,
  FORM_LOCALES,
  type CreateFormInvitationsInput,
  type CreateFormInvitationsResult,
  type FormLocale,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { useI18n } from '@/lib/i18n/provider';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useLists } from '@/hooks/queries/use-lists-queries';
import { usePersonSearch } from '@/components/objects/person/use-person-data';
import { useInviteToForm } from '@/hooks/queries/use-weldforms-results-queries';
import { errorMessage } from '../results/form-gate';
import { parseRecipientText } from './recipients';

type SourceTab = 'members' | 'people' | 'list' | 'paste';
type ReminderMode = 'default' | 'none' | 'custom';

interface PickedPerson {
  id: string;
  name: string;
  email: string | null;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function InviteDialog({
  formId,
  open,
  onOpenChange,
}: Readonly<{ formId: string; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t, format, language } = useI18n();
  const ti = t.weldformsResults.share.invite;
  const tc = t.weldformsResults.common;
  const invite = useInviteToForm(formId);

  const [tab, setTab] = useState<SourceTab>('members');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [people, setPeople] = useState<PickedPerson[]>([]);
  const [listId, setListId] = useState('');
  const [pasted, setPasted] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [locale, setLocale] = useState<FormLocale>(FORM_LOCALES.includes(language as FormLocale) ? (language as FormLocale) : 'en');
  const [reminderMode, setReminderMode] = useState<ReminderMode>('default');
  const [afterDays, setAfterDays] = useState(3);
  const [everyDays, setEveryDays] = useState(3);
  const [maxCount, setMaxCount] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateFormInvitationsResult | null>(null);

  const [memberSearch, setMemberSearch] = useState('');
  const [personSearch, setPersonSearch] = useState('');
  const debouncedPerson = useDebounced(personSearch.trim());

  const members = useDeskWorkspaceMembers();
  const personResults = usePersonSearch(debouncedPerson, tab === 'people');
  const lists = useLists('person', undefined, open && tab === 'list');
  const parsed = useMemo(() => parseRecipientText(pasted), [pasted]);

  // A closed dialog starts clean the next time it opens.
  useEffect(() => {
    if (open) return;
    setUserIds([]);
    setPeople([]);
    setListId('');
    setPasted('');
    setSubject('');
    setMessage('');
    setError(null);
    setResult(null);
    setMemberSearch('');
    setPersonSearch('');
  }, [open]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    const all = members.data ?? [];
    if (!q) return all;
    return all.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  }, [members.data, memberSearch]);

  const total = userIds.length + people.length + parsed.emails.length;
  const tooMany = total > FORM_LIMITS.maxInvitationsPerBatch && listId === '';
  const hasRecipients = total > 0 || listId !== '';

  const toggleUser = (id: string, checked: boolean) =>
    setUserIds((current) => (checked ? [...new Set([...current, id])] : current.filter((x) => x !== id)));

  async function send() {
    setError(null);
    if (!hasRecipients) {
      setError(ti.noRecipients);
      return;
    }
    if (tooMany) {
      setError(format(ti.tooMany, { max: FORM_LIMITS.maxInvitationsPerBatch }));
      return;
    }
    const input: CreateFormInvitationsInput = {
      recipients: {
        ...(parsed.emails.length > 0 ? { emails: parsed.emails } : {}),
        ...(userIds.length > 0 ? { userIds } : {}),
        ...(people.length > 0 ? { personIds: people.map((p) => p.id) } : {}),
        ...(listId ? { listId } : {}),
      },
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      locale,
      ...(reminderMode === 'none' ? { reminders: null } : {}),
      ...(reminderMode === 'custom' ? { reminders: { afterDays, everyDays, maxCount } } : {}),
    };
    try {
      const res = await invite.mutateAsync(input);
      setResult(res.data);
      toast.success(format(ti.sentSummary, { created: res.data.created }));
    } catch (err) {
      setError(errorMessage(err, ti.failed));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{result ? ti.sentTitle : ti.title}</DialogTitle>
          <DialogDescription>
            {result ? format(ti.sentSummary, { created: result.created }) : format(ti.description, { max: FORM_LIMITS.maxInvitationsPerBatch })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            {result.skipped.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">{ti.skippedTitle}</p>
                <ul className="max-h-60 space-y-1 overflow-auto rounded-md border p-2 text-sm">
                  {result.skipped.map((skip, index) => (
                    <li key={`${skip.email}-${index}`} className="flex justify-between gap-3">
                      <span className="truncate">{skip.email || tc.noValue}</span>
                      <span className="shrink-0 text-muted-foreground">{ti.skipReasons[skip.reason]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {ti.done}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-5">
            <Tabs value={tab} onValueChange={(value) => setTab(value as SourceTab)}>
              <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
                <TabsTrigger value="members">{ti.tabs.members}</TabsTrigger>
                <TabsTrigger value="people">{ti.tabs.people}</TabsTrigger>
                <TabsTrigger value="list">{ti.tabs.list}</TabsTrigger>
                <TabsTrigger value="paste">{ti.tabs.paste}</TabsTrigger>
              </TabsList>

              <TabsContent value="members" className="space-y-2">
                <SearchInput
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder={ti.membersSearch}
                  aria-label={ti.membersSearch}
                  className="w-full"
                />
                <ul className="max-h-52 space-y-1 overflow-auto rounded-md border p-2">
                  {filteredMembers.length === 0 && <li className="p-2 text-sm text-muted-foreground">{ti.membersEmpty}</li>}
                  {filteredMembers.map((member) => (
                    <li key={member.userId}>
                      <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/60">
                        <Checkbox
                          checked={userIds.includes(member.userId)}
                          onCheckedChange={(checked) => toggleUser(member.userId, checked === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{member.name}</span>
                          {member.email && member.email !== member.name && (
                            <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="people" className="space-y-2">
                <SearchInput
                  value={personSearch}
                  onChange={(e) => setPersonSearch(e.target.value)}
                  placeholder={ti.peopleSearch}
                  aria-label={ti.peopleSearch}
                  className="w-full"
                />
                <ul className="max-h-40 space-y-1 overflow-auto rounded-md border p-2">
                  {debouncedPerson === '' && <li className="p-2 text-sm text-muted-foreground">{ti.peopleHint}</li>}
                  {debouncedPerson !== '' && (personResults.data?.data ?? []).length === 0 && !personResults.isLoading && (
                    <li className="p-2 text-sm text-muted-foreground">{ti.peopleEmpty}</li>
                  )}
                  {(personResults.data?.data ?? []).map((person) => {
                    const picked = people.some((p) => p.id === person.id);
                    return (
                      <li key={person.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-muted/60">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{person.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">{person.email ?? ti.peopleNoEmail}</span>
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={picked || !person.email}
                          aria-label={format(ti.addPerson, { name: person.displayName })}
                          onClick={() =>
                            setPeople((current) => [...current, { id: person.id, name: person.displayName, email: person.email ?? null }])
                          }
                        >
                          {tc.add}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {people.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {people.map((person) => (
                      <li key={person.id} className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs">
                        {person.name}
                        <button
                          type="button"
                          aria-label={`${tc.remove} ${person.name}`}
                          className="rounded-full p-0.5 hover:bg-muted"
                          onClick={() => setPeople((current) => current.filter((p) => p.id !== person.id))}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="list" className="space-y-2">
                <Label htmlFor="invite-list">{ti.listLabel}</Label>
                {(lists.data?.data ?? []).length === 0 && !lists.isLoading ? (
                  <p className="text-sm text-muted-foreground">{ti.listEmpty}</p>
                ) : (
                  <Select value={listId || undefined} onValueChange={setListId}>
                    <SelectTrigger id="invite-list">
                      <SelectValue placeholder={ti.listPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {(lists.data?.data ?? []).map((list) => (
                        <SelectItem key={list.id} value={list.id}>
                          {list.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-muted-foreground">{ti.listHint}</p>
              </TabsContent>

              <TabsContent value="paste" className="space-y-2">
                <Label htmlFor="invite-paste">{ti.pasteLabel}</Label>
                <Textarea
                  id="invite-paste"
                  rows={5}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={ti.pastePlaceholder}
                />
                <p className="text-xs text-muted-foreground">{ti.pasteHint}</p>
                {parsed.invalid.length > 0 && (
                  <InlineError>{format(ti.pasteInvalid, { emails: parsed.invalid.join(', ') })}</InlineError>
                )}
              </TabsContent>
            </Tabs>

            <p className="text-sm text-muted-foreground" aria-live="polite">
              {listId ? ti.listHint : format(ti.recipientsCount, { count: total })}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="invite-subject">{ti.subject}</Label>
                <Input
                  id="invite-subject"
                  value={subject}
                  maxLength={255}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={ti.subjectPlaceholder}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="invite-message">{ti.message}</Label>
                <Textarea
                  id="invite-message"
                  rows={3}
                  value={message}
                  maxLength={5000}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={ti.messagePlaceholder}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-language">{ti.language}</Label>
                <Select value={locale} onValueChange={(value) => setLocale(value as FormLocale)}>
                  <SelectTrigger id="invite-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORM_LOCALES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ti.languages[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium">{ti.remindersTitle}</legend>
              <RadioGroup value={reminderMode} onValueChange={(value) => setReminderMode(value as ReminderMode)}>
                {(['default', 'none', 'custom'] as const).map((mode) => (
                  <div key={mode} className="flex items-center gap-2">
                    <RadioGroupItem value={mode} id={`invite-reminders-${mode}`} />
                    <Label htmlFor={`invite-reminders-${mode}`} className="font-normal">
                      {ti.remindersMode[mode]}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              {reminderMode === 'custom' && (
                <div className="grid grid-cols-3 gap-3">
                  <NumberField id="invite-after" label={ti.afterDays} value={afterDays} min={1} max={30} onChange={setAfterDays} />
                  <NumberField id="invite-every" label={ti.everyDays} value={everyDays} min={1} max={30} onChange={setEveryDays} />
                  <NumberField id="invite-max" label={ti.maxCount} value={maxCount} min={0} max={5} onChange={setMaxCount} />
                </div>
              )}
            </fieldset>

            {error && <InlineError>{error}</InlineError>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tc.cancel}
              </Button>
              <Button type="button" disabled={invite.isPending || !hasRecipients} onClick={() => void send()}>
                {invite.isPending ? ti.sending : ti.send}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: Readonly<{ id: string; label: string; value: number; min: number; max: number; onChange: (value: number) => void }>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
    </div>
  );
}
