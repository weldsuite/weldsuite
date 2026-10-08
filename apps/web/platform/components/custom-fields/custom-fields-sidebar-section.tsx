
import { useEffect, useState, useRef, useCallback } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Star,
  Check,
  X,
  ExternalLink,
  Type,
  AlignLeft,
  Hash,
  Mail,
  Phone,
  Link,
  Calendar,
  ToggleLeft,
  ChevronDown,
  List,
  DollarSign,
  Paperclip,
  User,
  Database,
  Braces,
  type LucideIcon,
} from 'lucide-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';
import { asText } from '@weldsuite/text';

interface CustomFieldsSidebarSectionProps {
  entityType: string;
  values: Record<string, unknown> | null | undefined;
  /**
   * Persist the full updated customFields blob. The component owns the merge
   * (`{ ...values, [slug]: newValue }`) and hands the result back to the
   * parent, which is responsible for the actual mutation.
   */
  onSave: (next: Record<string, unknown>) => Promise<void>;
  /** Optional post-save hook (cache invalidation, toasts). */
  onSaved?: () => void;
  hideHeader?: boolean;
  /**
   * `stacked` (default) — the standalone section look: a "Custom Fields"
   * heading, grouped sub-sections, label-above-value fields.
   *
   * `row` — fold the fields straight into a surrounding Details list. No
   * heading, no group sub-sections, no separator; each field renders as an
   * icon + label + inline value row matching `PropertyRow`, so custom fields
   * read as part of the standard fields rather than a separate category.
   */
  layout?: 'stacked' | 'row';
}

export function CustomFieldsSidebarSection({
  entityType,
  values,
  onSave,
  onSaved,
  hideHeader,
  layout = 'stacked',
}: Readonly<CustomFieldsSidebarSectionProps>) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [fieldDefs, setFieldDefs] = useState<CustomFieldDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    void (async () => {
      try {
        const client = await getClient();
        const query = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
        // app-api GET /api/custom-fields (was api-worker GET /settings/custom-fields).
        const result = await client.get<{ data?: CustomFieldDefinition[] }>(`/custom-fields${query}`);
        if (mounted && result.data) {
          setFieldDefs(result.data);
        }
      } catch {
        // Ignore errors loading custom fields
      }
      if (mounted) setIsLoading(false);
    })();
    return () => { mounted = false; };
  }, [entityType, getClient]);

  const handleUpdateField = useCallback(async (slug: string, newValue: unknown) => {
    try {
      const updatedFields = { ...values, [slug]: newValue };
      await onSave(updatedFields);
      onSaved?.();
    } catch {
      toast.error(t('sweep.entities.updateFieldFailed'));
    }
  }, [values, onSave, onSaved, t]);

  if (isLoading || fieldDefs.length === 0) return null;

  // Group fields: ungrouped first, then by group name
  const ungrouped = fieldDefs.filter(d => !d.group);
  const grouped = fieldDefs.filter(d => d.group);
  const groups = [...new Set(grouped.map(d => d.group!))];

  if (layout === 'row') {
    // Flattened into the surrounding Details list — no heading, no group
    // sub-sections, no separator. Groups collapse into a single ordered list
    // so the fields blend in with the standard PropertyRows above them.
    const orderedDefs = [...ungrouped, ...grouped];
    return (
      <div className="space-y-1">
        {orderedDefs.map(def => (
          <EditableCustomField
            key={def.slug}
            def={def}
            value={values?.[def.slug]}
            onUpdate={handleUpdateField}
            layout="row"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!hideHeader && <h3 className="text-sm font-medium text-foreground">{t('sweep.entities.customFieldsHeading')}</h3>}

      {ungrouped.length > 0 && (
        <div className="space-y-2">
          {ungrouped.map(def => (
            <EditableCustomField
              key={def.slug}
              def={def}
              value={values?.[def.slug]}
              onUpdate={handleUpdateField}
            />
          ))}
        </div>
      )}

      {groups.map(group => (
        <div key={group} className="space-y-2">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{group}</span>
          {grouped.filter(d => d.group === group).map(def => (
            <EditableCustomField
              key={def.slug}
              def={def}
              value={values?.[def.slug]}
              onUpdate={handleUpdateField}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// Field-type → icon, keyed by the canonical `FIELD_TYPES` values from the
// custom-fields settings catalog (see app/settings/custom-fields/entity-types).
// Kept local to avoid importing from a settings page component. Unknown types
// fall back to the generic `Braces` glyph.
const FIELD_TYPE_ICON: Record<string, LucideIcon> = {
  text: Type,
  textarea: AlignLeft,
  number: Hash,
  date: Calendar,
  boolean: ToggleLeft,
  single_select: ChevronDown,
  multi_select: List,
  url: Link,
  email: Mail,
  phone: Phone,
  currency: DollarSign,
  rating: Star,
  file: Paperclip,
  user_ref: User,
  entity_ref: Database,
};

/** Everything the per-layout field renderers need from `EditableCustomField`. */
interface FieldContext {
  def: CustomFieldDefinition;
  value: unknown;
  hasValue: boolean;
  isSaving: boolean;
  isEditing: boolean;
  editValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onEditValueChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onStartEdit: () => void;
  onImmediateSave: (value: unknown) => void;
}

const INLINE_INPUT_CLASS =
  'flex-1 min-w-0 text-sm bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[9px] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500';

function EditableCustomField({
  def,
  value,
  onUpdate,
  layout = 'stacked',
}: Readonly<{
  def: CustomFieldDefinition;
  value: unknown;
  onUpdate: (slug: string, value: unknown) => Promise<void>;
  layout?: 'stacked' | 'row';
}>) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    setEditValue(value != null ? asText(value) : '');
    setIsEditing(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      let parsedValue: unknown = editValue.trim();
      if (def.fieldType === 'number' || def.fieldType === 'currency') {
        parsedValue = parsedValue === '' ? null : Number(parsedValue);
      }
      if (parsedValue === '' && value == null) {
        setIsEditing(false);
        return;
      }
      await onUpdate(def.slug, parsedValue === '' ? null : parsedValue);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue('');
    setIsEditing(false);
  };

  const handleImmediateSave = async (newValue: unknown) => {
    setIsSaving(true);
    try {
      await onUpdate(def.slug, newValue);
    } finally {
      setIsSaving(false);
    }
  };

  const ctx: FieldContext = {
    def,
    value,
    hasValue: value != null && value !== '' && !(Array.isArray(value) && value.length === 0),
    isSaving,
    isEditing,
    editValue,
    inputRef,
    onEditValueChange: setEditValue,
    onSave: handleSave,
    onCancel: handleCancel,
    onStartEdit: handleStartEdit,
    onImmediateSave: handleImmediateSave,
  };

  // Row layout — an icon + label + inline value row matching `PropertyRow`,
  // so custom fields sit inside the Details list rather than in a separate
  // section. The type-specific editors are the same as the stacked variant;
  // only the surrounding shell (label placement) differs.
  return layout === 'row' ? <RowField ctx={ctx} /> : <StackedField ctx={ctx} />;
}

function EditActions({
  isSaving,
  onSave,
  onCancel,
}: Readonly<{ isSaving: boolean; onSave: () => void; onCancel: () => void }>) {
  return (
    <>
      <Button
        variant="ghost"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSave}
        disabled={isSaving}
        className="p-0.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCancel}
        className="p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-secondary rounded transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}

/** Inline input + save/cancel buttons for the date and text-like field types. */
function InlineEditor({ ctx, className }: Readonly<{ ctx: FieldContext; className: string }>) {
  const { def, value, isSaving, editValue, inputRef, onEditValueChange, onSave, onCancel } = ctx;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSave();
    if (e.key === 'Escape') onCancel();
  };

  let input: React.ReactNode;
  if (def.fieldType === 'date') {
    input = (
      <input
        ref={inputRef}
        type="date"
        defaultValue={value ? new Date(asText(value)).toISOString().split('T')[0] : ''}
        onChange={(e) => onEditValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isSaving}
        className={INLINE_INPUT_CLASS}
      />
    );
  } else {
    const isNumeric = def.fieldType === 'number' || def.fieldType === 'currency';
    input = (
      <input
        ref={inputRef}
        type={isNumeric ? 'number' : 'text'}
        value={editValue}
        onChange={(e) => onEditValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        disabled={isSaving}
        step={def.fieldType === 'currency' ? '0.01' : undefined}
        className={INLINE_INPUT_CLASS}
      />
    );
  }

  return (
    <div className={className}>
      {input}
      <EditActions isSaving={isSaving} onSave={onSave} onCancel={onCancel} />
    </div>
  );
}

function BooleanControl({
  value,
  isSaving,
  onChange,
}: Readonly<{ value: unknown; isSaving: boolean; onChange: (checked: boolean) => void }>) {
  return <Switch checked={!!value} disabled={isSaving} onCheckedChange={(checked) => onChange(checked)} />;
}

function RatingControl({
  def,
  value,
  isSaving,
  onChange,
  className,
}: Readonly<{
  def: CustomFieldDefinition;
  value: unknown;
  isSaving: boolean;
  onChange: (rating: number) => void;
  className: string;
}>) {
  const maxRating = (def.config as { maxRating?: number } | null)?.maxRating ?? 5;
  const ratingValue = Number(value) || 0;
  return (
    <div className={className}>
      {Array.from({ length: maxRating }, (_, i) => (
        <Button
          key={i}
          type="button"
          variant="ghost"
          disabled={isSaving}
          onClick={() => onChange(ratingValue === i + 1 ? 0 : i + 1)}
          className="p-0 focus:outline-none disabled:opacity-50"
        >
          <Star
            className={cn(
              'h-4 w-4 transition-colors',
              i < ratingValue
                ? 'fill-yellow-400 text-yellow-400'
                : 'text-muted-foreground/30 hover:text-yellow-300',
            )}
          />
        </Button>
      ))}
    </div>
  );
}

function SingleSelectControl({
  def,
  hasValue,
  value,
  isSaving,
  placeholder,
  onChange,
}: Readonly<{
  def: CustomFieldDefinition;
  hasValue: boolean;
  value: unknown;
  isSaving: boolean;
  placeholder: string;
  onChange: (value: string | null) => void;
}>) {
  const t = useTranslations();
  const options = def.options ?? [];
  return (
    <Select
      value={hasValue ? String(value) : ''}
      disabled={isSaving}
      onValueChange={(v) => onChange(v === '__clear__' ? null : v)}
    >
      <SelectTrigger className="h-7 text-sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__clear__">
          <span className="text-muted-foreground">{t('sweep.entities.clear')}</span>
        </SelectItem>
        {options.map(opt => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiSelectControl({
  def,
  value,
  isSaving,
  onChange,
  className,
}: Readonly<{
  def: CustomFieldDefinition;
  value: unknown;
  isSaving: boolean;
  onChange: (values: string[]) => void;
  className: string;
}>) {
  const options = def.options ?? [];
  const selectedValues = Array.isArray(value) ? (value as string[]) : [];

  const toggleOption = (optionValue: string) => {
    onChange(
      selectedValues.includes(optionValue)
        ? selectedValues.filter(v => v !== optionValue)
        : [...selectedValues, optionValue],
    );
  };

  return (
    <div className={className}>
      {options.map(opt => {
        const isSelected = selectedValues.includes(opt.value);
        return (
          <Button
            key={opt.value}
            type="button"
            variant="ghost"
            disabled={isSaving}
            onClick={() => toggleOption(opt.value)}
            className="disabled:opacity-50"
          >
            <Badge
              variant={isSelected ? 'default' : 'outline'}
              className="cursor-pointer"
              style={isSelected && opt.color ? { backgroundColor: opt.color, color: '#fff' } : undefined}
            >
              {opt.label}
            </Badge>
          </Button>
        );
      })}
    </div>
  );
}

const ROW_EDITOR_CLASS = 'flex items-center gap-1.5';
const STACKED_EDITOR_CLASS = 'flex items-center gap-1.5 mt-0.5';

function RowDisplayContent({
  ctx,
  placeholder,
}: Readonly<{ ctx: FieldContext; placeholder: string }>) {
  const { def, value, hasValue } = ctx;
  if (!hasValue) return <span className="text-muted-foreground/70">{placeholder}</span>;
  if (def.fieldType === 'date') return <span>{new Date(String(value)).toLocaleDateString()}</span>;
  return <>{renderDisplayValue(def, value, hasValue)}</>;
}

function RowCell({ ctx, placeholder }: Readonly<{ ctx: FieldContext; placeholder: string }>) {
  const { def, value, hasValue, isSaving, isEditing, onStartEdit, onImmediateSave } = ctx;

  switch (def.fieldType) {
    case 'boolean':
      return <BooleanControl value={value} isSaving={isSaving} onChange={onImmediateSave} />;
    case 'rating':
      return (
        <RatingControl
          def={def}
          value={value}
          isSaving={isSaving}
          onChange={onImmediateSave}
          className="flex items-center gap-0.5"
        />
      );
    case 'single_select':
      return (
        <SingleSelectControl
          def={def}
          hasValue={hasValue}
          value={value}
          isSaving={isSaving}
          placeholder={placeholder}
          onChange={onImmediateSave}
        />
      );
    case 'multi_select':
      return (
        <MultiSelectControl
          def={def}
          value={value}
          isSaving={isSaving}
          onChange={onImmediateSave}
          className="flex flex-wrap gap-1"
        />
      );
    default:
      // date, text, textarea, email, phone, url, number, currency
      return isEditing ? (
        <InlineEditor ctx={ctx} className={ROW_EDITOR_CLASS} />
      ) : (
        <div
          className="cursor-text rounded-[9px] px-2 -mx-2 hover:bg-muted/50 transition-colors flex items-center min-h-[32px]"
          role="button"
          tabIndex={0}
          onClick={onStartEdit}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onStartEdit();
            }
          }}
        >
          <RowDisplayContent ctx={ctx} placeholder={placeholder} />
        </div>
      );
  }
}

function RowField({ ctx }: Readonly<{ ctx: FieldContext }>) {
  const t = useTranslations();
  const { def } = ctx;
  const FieldIcon = FIELD_TYPE_ICON[def.fieldType] ?? Braces;
  const placeholder = t('sweep.entities.setFieldPlaceholder', { label: def.name });

  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      {/* Field-type icon mirrors the standard PropertyRows so custom fields
          read as part of the Details list rather than a separate, icon-less
          category. */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <FieldIcon className="h-4 w-4 shrink-0" />
        <span className="truncate">{def.name}</span>
      </div>
      <div className="text-sm min-w-0">
        <RowCell ctx={ctx} placeholder={placeholder} />
      </div>
    </div>
  );
}

function LabeledField({ name, children }: Readonly<{ name: string; children: React.ReactNode }>) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{name}</span>
      {children}
    </div>
  );
}

function StackedDisplayContent({ ctx }: Readonly<{ ctx: FieldContext }>) {
  const { def, value, hasValue } = ctx;
  if (hasValue && def.fieldType === 'date') {
    return <span className="text-sm">{new Date(String(value)).toLocaleDateString()}</span>;
  }
  return <>{renderDisplayValue(def, value, hasValue)}</>;
}

function StackedField({ ctx }: Readonly<{ ctx: FieldContext }>) {
  const { def, value, hasValue, isSaving, isEditing, onStartEdit, onImmediateSave } = ctx;

  switch (def.fieldType) {
    // Boolean toggle — immediate save, no edit mode
    case 'boolean':
      return (
        <div className="flex items-center justify-between rounded -mx-1 px-1 py-0.5">
          <span className="text-xs text-muted-foreground">{def.name}</span>
          <BooleanControl value={value} isSaving={isSaving} onChange={onImmediateSave} />
        </div>
      );
    // Rating — immediate save via clickable stars
    case 'rating':
      return (
        <LabeledField name={def.name}>
          <RatingControl
            def={def}
            value={value}
            isSaving={isSaving}
            onChange={onImmediateSave}
            className="flex items-center gap-0.5 mt-0.5"
          />
        </LabeledField>
      );
    // Single select — immediate save via dropdown
    case 'single_select':
      return (
        <LabeledField name={def.name}>
          <div className="mt-0.5">
            <SingleSelectControl
              def={def}
              hasValue={hasValue}
              value={value}
              isSaving={isSaving}
              placeholder="—"
              onChange={onImmediateSave}
            />
          </div>
        </LabeledField>
      );
    // Multi select — toggle individual options immediately
    case 'multi_select':
      return (
        <LabeledField name={def.name}>
          <MultiSelectControl
            def={def}
            value={value}
            isSaving={isSaving}
            onChange={onImmediateSave}
            className="flex flex-wrap gap-1 mt-1"
          />
        </LabeledField>
      );
    default:
      // Date and text-like fields (text, textarea, email, phone, url, number, currency)
      if (isEditing) {
        return (
          <LabeledField name={def.name}>
            <InlineEditor ctx={ctx} className={STACKED_EDITOR_CLASS} />
          </LabeledField>
        );
      }
      return (
        <div
          className="rounded -mx-1 px-1 cursor-text hover:bg-gray-50 dark:hover:bg-secondary/50 transition-colors"
          role="button"
          tabIndex={0}
          onClick={onStartEdit}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onStartEdit();
            }
          }}
        >
          <span className="text-xs text-muted-foreground">{def.name}</span>
          <div className="mt-0.5">
            <StackedDisplayContent ctx={ctx} />
          </div>
        </div>
      );
  }
}

function renderDisplayValue(def: CustomFieldDefinition, value: unknown, hasValue: boolean) {
  if (!hasValue) {
    return <span className="text-sm text-muted-foreground/50">—</span>;
  }

  switch (def.fieldType) {
    case 'email':
      return (
        <a href={`mailto:${String(value)}`} className="text-sm text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );

    case 'phone':
      return (
        <a href={`tel:${String(value)}`} className="text-sm text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );

    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
          <ExternalLink className="h-3 w-3" />
        </a>
      );

    case 'number':
      return <span className="text-sm">{Number(value).toLocaleString()}</span>;

    case 'currency': {
      const config = def.config as { currency?: string } | null;
      const currency = config?.currency || 'EUR';
      try {
        const formatted = new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
        }).format(Number(value));
        return <span className="text-sm">{formatted}</span>;
      } catch {
        return <span className="text-sm">{String(value)}</span>;
      }
    }

    default:
      return <span className="text-sm">{String(value)}</span>;
  }
}
