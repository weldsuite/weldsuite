import { toast } from 'sonner';
import {
  AlignLeft,
  CalendarDays,
  CircleChevronDown,
  Coins,
  Flag,
  Hash,
  Link2,
  ListChecks,
  Mail,
  Phone,
  Shapes,
  Star,
  Tag,
  ToggleLeft,
  Type,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { Switch } from '@weldsuite/ui/components/switch';
import { Toggle } from '@weldsuite/ui/components/toggle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PropertyRow, TagsPropertyRow, type PropertyRowProps } from '@/components/objects/_shared/property-row';
import { SelectPropertyRow } from '@/components/objects/_shared/select-property-row';
import {
  DESK_PRIORITIES,
  useDeskAttributeOptions,
  useUpdateDeskConversationAttributes,
  type DeskAttributesUpdate,
  type DeskConversation,
  type DeskPriority,
  type DeskTicketField,
} from '@/hooks/queries/use-desk-queries';
import { ImpactUrgencyFields } from './impact-urgency-fields';

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

export function PickOne({
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

const FIELD_ICON: Record<string, LucideIcon> = {
  text: Type,
  textarea: AlignLeft,
  number: Hash,
  currency: Coins,
  rating: Star,
  date: CalendarDays,
  email: Mail,
  url: Link2,
  phone: Phone,
  boolean: ToggleLeft,
  single_select: CircleChevronDown,
  multi_select: ListChecks,
};

/** The property-row editor each text-like field type gets; the rest edit as plain text. */
const ROW_TYPE: Partial<Record<string, NonNullable<PropertyRowProps['type']>>> = {
  textarea: 'address',
  date: 'date',
  email: 'email',
  url: 'url',
  phone: 'phone',
};

const NUMERIC_TYPES = new Set(['number', 'currency', 'rating']);

function asText(field: DeskTicketField, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (field.fieldType === 'date' && typeof value === 'string') return value.slice(0, 10);
  return String(value);
}

/** A row in the property rows' geometry whose value is a control of its own (a switch, toggles). */
function ControlRow({
  icon: Icon,
  label,
  children,
}: Readonly<{ icon: LucideIcon; label: string; children: React.ReactNode }>) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="truncate" title={label}>{label}</span>
      </div>
      <div className="min-w-0 py-1">{children}</div>
      <div />
    </div>
  );
}

/** One of the ticket type's custom fields, as a property row of the record panel. */
function CustomFieldRow({
  field,
  value,
  onSave,
  t,
}: Readonly<{ field: DeskTicketField; value: unknown; onSave: (value: unknown) => void; t: T }>) {
  const icon = FIELD_ICON[field.fieldType] ?? Type;
  const label = field.required ? `${field.name} *` : field.name;

  if (field.fieldType === 'boolean') {
    return (
      <ControlRow icon={icon} label={label}>
        <Switch checked={value === true} onCheckedChange={(checked) => onSave(checked)} aria-label={field.name} />
      </ControlRow>
    );
  }
  if (field.fieldType === 'single_select') {
    return (
      <SelectPropertyRow
        icon={icon}
        label={label}
        value={typeof value === 'string' ? value : null}
        options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        onChange={onSave}
        placeholder={t.ticket.choose}
      />
    );
  }
  if (field.fieldType === 'multi_select') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <ControlRow icon={icon} label={label}>
        <div className="flex flex-wrap gap-1">
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
              >
                {option.label}
              </Toggle>
            );
          })}
        </div>
      </ControlRow>
    );
  }

  const numeric = NUMERIC_TYPES.has(field.fieldType);
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={asText(field, value)}
      type={ROW_TYPE[field.fieldType] ?? 'text'}
      onSave={(next) => {
        const trimmed = next?.trim() ?? '';
        if (trimmed === '') {
          onSave(null);
          return;
        }
        if (numeric) {
          const number = Number(trimmed);
          if (!Number.isFinite(number)) {
            toast.error(t.ticket.saveError);
            return;
          }
          onSave(number);
          return;
        }
        onSave(trimmed);
      }}
    />
  );
}

/**
 * The conversation's ticket fields: type, priority, impact and urgency, team,
 * tags and the type's custom fields, as property rows of the record panel's
 * Details tab. Each change saves on its own and lands on the timeline as an
 * internal event.
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
  const knownTags = (options?.tags ?? []).map((entry) => entry.tag);

  return (
    <section className="space-y-2" data-testid="desk-inbox-ticket-fields">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t.ticket.title}</h3>
        <Link href="/settings/apps/welddesk/ticket-types" className="text-xs text-muted-foreground hover:text-foreground">
          {t.ticket.manageTypes}
        </Link>
      </div>

      <div className="space-y-1">
        <SelectPropertyRow
          icon={Shapes}
          label={t.ticket.type}
          value={conversation.ticketTypeId}
          options={types.map((type) => ({ value: type.id, label: type.name }))}
          onChange={(ticketTypeId) => save({ ticketTypeId })}
          placeholder={t.ticket.noType}
        />
        <SelectPropertyRow
          icon={Flag}
          label={t.ticket.priority}
          value={conversation.priority}
          options={DESK_PRIORITIES.map((priority) => ({ value: priority, label: t.ticket.priorities[priority] }))}
          onChange={(priority) => save({ priority: priority as DeskPriority | null })}
          placeholder={t.ticket.noPriority}
        />
        <ImpactUrgencyFields conversation={conversation} save={save} />
        <SelectPropertyRow
          icon={Users}
          label={t.ticket.team}
          value={conversation.departmentId}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          onChange={(departmentId) => save({ departmentId })}
          placeholder={teams.length ? t.ticket.noTeam : t.ticket.noTeamsYet}
        />
        <TagsPropertyRow
          icon={Tag}
          label={t.ticket.tags}
          value={conversation.tags ?? []}
          placeholder={t.ticket.addTag}
          getSuggestions={() => knownTags}
          onChange={(tags) => {
            if (tags.length > MAX_TAGS) {
              toast.error(t.ticket.maxTags.replace('{max}', String(MAX_TAGS)));
              return;
            }
            save({ tags });
          }}
        />
      </div>

      {fields.length > 0 && (
        <div className="space-y-1">
          {typeName && <p className="text-xs text-muted-foreground pt-2">{typeName}</p>}
          {fields.map((field) => (
            <CustomFieldRow
              key={field.id}
              field={field}
              value={values[field.slug]}
              onSave={(value) => save({ customFields: { [field.slug]: value } })}
              t={t}
            />
          ))}
        </div>
      )}
    </section>
  );
}
