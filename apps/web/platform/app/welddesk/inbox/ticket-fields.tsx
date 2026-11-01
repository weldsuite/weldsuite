import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Toggle } from '@weldsuite/ui/components/toggle';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  DESK_PRIORITIES,
  useDeskAttributeOptions,
  useUpdateDeskConversationAttributes,
  type DeskAttributesUpdate,
  type DeskConversation,
  type DeskPriority,
  type DeskTicketField,
} from '@/hooks/queries/use-desk-queries';

/** Radix Select can't hold an empty value; this stands for "not set". */
const NONE = '__none__';
/** Mirrors DESK_MAX_TAGS on the server. */
const MAX_TAGS = 20;

export const PRIORITY_DOT: Record<DeskPriority, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
  low: 'bg-muted-foreground/40',
};

type T = ReturnType<typeof getTranslations<'deskInbox2'>>;

function FieldRow({ label, required, children }: Readonly<{ label: string; required?: boolean; children: React.ReactNode }>) {
  const t = getTranslations('deskInbox2');
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground flex-shrink-0 max-w-[45%] truncate" title={label}>
        {label}
        {required && (
          <span className="text-destructive" title={t.ticket.required}>
            {' '}*
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1 flex justify-end">{children}</div>
    </div>
  );
}

function PickOne({
  value,
  noneLabel,
  items,
  onChange,
  disabled,
  testId,
}: Readonly<{
  value: string | null | undefined;
  noneLabel: string;
  items: Array<{ value: string; label: string; dot?: string }>;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  testId?: string;
}>) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger className="h-7 w-full max-w-[160px] text-sm shadow-none" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{noneLabel}</span>
        </SelectItem>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <span className="inline-flex items-center gap-2">
              {item.dot && <span className={cn('h-2 w-2 rounded-full', item.dot)} />}
              {item.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TagEditor({
  tags,
  suggestions,
  onChange,
}: Readonly<{ tags: string[]; suggestions: string[]; onChange: (tags: string[]) => void }>) {
  const t = getTranslations('deskInbox2');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const lower = new Set(tags.map((tag) => tag.toLowerCase()));
  const term = query.trim();
  const matches = suggestions.filter(
    (tag) => !lower.has(tag.toLowerCase()) && tag.toLowerCase().includes(term.toLowerCase()),
  );
  const canCreate = term.length > 0 && !lower.has(term.toLowerCase()) && !matches.some((tag) => tag.toLowerCase() === term.toLowerCase());

  const add = (tag: string) => {
    if (tags.length >= MAX_TAGS) {
      toast.error(t.ticket.maxTags.replace('{max}', String(MAX_TAGS)));
      return;
    }
    onChange([...tags, tag]);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1" data-testid="desk-ticket-tags">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/50 pl-1.5 pr-0.5 py-0.5 text-xs"
        >
          {tag}
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onChange(tags.filter((other) => other !== tag))}
            aria-label={t.ticket.removeTag.replace('{tag}', tag)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground">
            <Plus className="h-3 w-3 mr-0.5" />
            {t.ticket.addTag}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={t.ticket.tagSearch} value={query} onValueChange={setQuery} maxLength={50} />
            <CommandList className="max-h-56">
              {!canCreate && <CommandEmpty>{t.ticket.noTags}</CommandEmpty>}
              {canCreate && (
                <CommandItem value={`__create__${term}`} onSelect={() => add(term)}>
                  <Plus className="h-3.5 w-3.5" />
                  {t.ticket.createTag.replace('{tag}', term)}
                </CommandItem>
              )}
              {matches.map((tag) => (
                <CommandItem key={tag} value={tag} onSelect={() => add(tag)}>
                  {tag}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function asDraft(field: DeskTicketField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.fieldType === 'date' && typeof value === 'string') return value.slice(0, 10);
  return String(value);
}

/** A text-like input that saves when it loses focus (or on Enter). */
function DraftInput({
  field,
  value,
  onSave,
}: Readonly<{ field: DeskTicketField; value: unknown; onSave: (value: unknown) => void }>) {
  const stored = asDraft(field, value);
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);

  const numeric = field.fieldType === 'number' || field.fieldType === 'currency' || field.fieldType === 'rating';
  const commit = () => {
    if (draft === stored) return;
    if (draft.trim() === '') onSave(null);
    else onSave(numeric ? Number(draft) : draft);
  };
  const common = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    'aria-label': field.name,
    'data-testid': `desk-ticket-field-${field.slug}`,
  };

  if (field.fieldType === 'textarea') {
    return <Textarea {...common} rows={2} className="min-h-0 text-sm shadow-none resize-y" />;
  }
  const inputType: Record<string, string> = { number: 'number', currency: 'number', rating: 'number', date: 'date', email: 'email', url: 'url', phone: 'tel' };
  return (
    <Input
      {...common}
      type={inputType[field.fieldType] ?? 'text'}
      className="h-7 w-full max-w-[160px] text-sm shadow-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

function CustomFieldInput({
  field,
  value,
  onSave,
  t,
}: Readonly<{ field: DeskTicketField; value: unknown; onSave: (value: unknown) => void; t: T }>) {
  if (field.fieldType === 'boolean') {
    return <Switch checked={value === true} onCheckedChange={(checked) => onSave(checked)} aria-label={field.name} />;
  }
  if (field.fieldType === 'single_select') {
    return (
      <PickOne
        value={typeof value === 'string' ? value : null}
        noneLabel={t.ticket.choose}
        items={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        onChange={onSave}
        testId={`desk-ticket-field-${field.slug}`}
      />
    );
  }
  if (field.fieldType === 'multi_select') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {(field.options ?? []).map((option) => {
          const on = selected.includes(option.value);
          return (
            <Toggle
              key={option.value}
              size="sm"
              variant="outline"
              pressed={on}
              onPressedChange={() =>
                onSave(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])
              }
              className="h-6 px-2 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
            >
              {option.label}
            </Toggle>
          );
        })}
      </div>
    );
  }
  return <DraftInput field={field} value={value} onSave={onSave} />;
}

/**
 * The conversation's ticket fields: type, priority, team, tags and the
 * type's custom fields. Each change saves on its own and lands on the
 * timeline as an internal event.
 */
export function TicketFields({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('deskInbox2');
  const { data: options } = useDeskAttributeOptions();
  const update = useUpdateDeskConversationAttributes();

  const save = (data: DeskAttributesUpdate) =>
    update.mutate({ id: conversation.id, data }, { onError: () => toast.error(t.ticket.saveError) });

  const types = options?.ticketTypes ?? [];
  const teams = options?.teams ?? [];
  // A type's own fields plus the ones that apply to every type, as the server resolves them.
  const fields = (options?.fields ?? []).filter(
    (field) => field.ticketTypeId === null || field.ticketTypeId === conversation.ticketTypeId,
  );
  const values = conversation.customFields ?? {};
  const typeName = types.find((type) => type.id === conversation.ticketTypeId)?.name;

  return (
    <div className="px-4 py-3 border-b border-border/60" data-testid="desk-inbox-ticket-fields">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.ticket.title}</p>
        <Link href="/welddesk/settings/ticket-types" className="text-xs text-muted-foreground hover:text-foreground">
          {t.ticket.manageTypes}
        </Link>
      </div>

      <FieldRow label={t.ticket.type}>
        <PickOne
          value={conversation.ticketTypeId}
          noneLabel={t.ticket.noType}
          items={types.map((type) => ({ value: type.id, label: type.name }))}
          onChange={(ticketTypeId) => save({ ticketTypeId })}
          testId="desk-ticket-type"
        />
      </FieldRow>
      <FieldRow label={t.ticket.priority}>
        <PickOne
          value={conversation.priority}
          noneLabel={t.ticket.noPriority}
          items={DESK_PRIORITIES.map((priority) => ({
            value: priority,
            label: t.ticket.priorities[priority],
            dot: PRIORITY_DOT[priority],
          }))}
          onChange={(priority) => save({ priority: priority as DeskPriority | null })}
          testId="desk-ticket-priority"
        />
      </FieldRow>
      <FieldRow label={t.ticket.team}>
        <PickOne
          value={conversation.departmentId}
          noneLabel={teams.length ? t.ticket.noTeam : t.ticket.noTeamsYet}
          items={teams.map((team) => ({ value: team.id, label: team.name }))}
          onChange={(departmentId) => save({ departmentId })}
          disabled={teams.length === 0 && !conversation.departmentId}
          testId="desk-ticket-team"
        />
      </FieldRow>
      <FieldRow label={t.ticket.tags}>
        <TagEditor
          tags={conversation.tags ?? []}
          suggestions={(options?.tags ?? []).map((entry) => entry.tag)}
          onChange={(tags) => save({ tags })}
        />
      </FieldRow>

      {fields.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/40">
          {typeName && <p className="text-xs text-muted-foreground mb-1">{typeName}</p>}
          {fields.map((field) => (
            <FieldRow key={field.id} label={field.name} required={field.required}>
              <CustomFieldInput
                field={field}
                value={values[field.slug]}
                onSave={(value) => save({ customFields: { [field.slug]: value } })}
                t={t}
              />
            </FieldRow>
          ))}
        </div>
      )}
    </div>
  );
}
