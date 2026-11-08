/**
 * Create / edit one routing rule in a side sheet: its conditions (channel,
 * type, tag, priority, team) and actions (team, assignee, priority, tags).
 * Saving hands the edited rule back; the page saves the whole ordered list.
 */

import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import type { DeskRoutingRule } from '@/hooks/queries/use-desk-routing-queries';
import {
  ROUTING_CHANNELS,
  ROUTING_PRIORITIES,
  cleanTags,
  emptyRoutingValues,
  ruleToValues,
  validateRoutingValues,
  type RoutingChannel,
  type RoutingFormError,
  type RoutingFormValues,
  type RoutingPriority,
} from './routing-form';

type Strings = ReturnType<typeof getTranslations<'helpdesk'>>['routing'];

/** What the pickers offer. */
export interface RoutingOptions {
  ticketTypes: MultiSelectOption[];
  teams: MultiSelectOption[];
  members: MultiSelectOption[];
  tags: string[];
}

export interface RoutingRuleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule to edit; null creates one. */
  rule: DeskRoutingRule | null;
  options: RoutingOptions;
  saving: boolean;
  onSave: (values: RoutingFormValues) => Promise<boolean>;
}

export function RoutingRuleEditor({ open, onOpenChange, rule, options, saving, onSave }: Readonly<RoutingRuleEditorProps>) {
  const t = getTranslations('helpdesk').routing;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl" data-testid="routing-rule-editor">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{rule ? t.editor.editTitle : t.editor.createTitle}</SheetTitle>
          <SheetDescription>{t.editor.description}</SheetDescription>
        </SheetHeader>
        {open && (
          <RoutingRuleForm
            key={rule?.id ?? 'new'}
            rule={rule}
            options={options}
            saving={saving}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
            t={t}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

const KEEP = '__keep__';

function RoutingRuleForm({
  rule,
  options,
  saving,
  onSave,
  onClose,
  t,
}: Readonly<{
  rule: DeskRoutingRule | null;
  options: RoutingOptions;
  saving: boolean;
  onSave: (values: RoutingFormValues) => Promise<boolean>;
  onClose: () => void;
  t: Strings;
}>) {
  const [values, setValues] = useState<RoutingFormValues>(() => (rule ? ruleToValues(rule) : emptyRoutingValues()));
  const [error, setError] = useState<RoutingFormError | null>(null);
  const set = <K extends keyof RoutingFormValues>(key: K, value: RoutingFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const channelOptions = ROUTING_CHANNELS.map((c) => ({ value: c, label: t.channels[c] }));
  const priorityOptions = ROUTING_PRIORITIES.map((p) => ({ value: p, label: t.priorities[p] }));
  const multi = { searchPlaceholder: t.editor.search, emptyText: t.editor.noResults, placeholder: t.editor.any, modal: true };

  const submit = async () => {
    const problem = validateRoutingValues(values);
    setError(problem);
    if (problem) return;
    if (await onSave(values)) onClose();
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="routing-rule-form"
    >
      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <section className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="routing-rule-name">{t.editor.name}</Label>
            <Input
              id="routing-rule-name"
              value={values.name}
              maxLength={120}
              placeholder={t.editor.namePlaceholder}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={error === 'nameRequired'}
            />
            {error === 'nameRequired' && <p className="text-sm text-destructive">{t.editor.nameRequired}</p>}
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="routing-rule-enabled">{t.editor.enabled}</Label>
            <Switch id="routing-rule-enabled" checked={values.enabled} onCheckedChange={(on) => set('enabled', on)} />
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="font-medium">{t.editor.conditionsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.editor.conditionsHint}</p>
          </div>
          <Field label={t.editor.channels}>
            <MultiSelect
              {...multi}
              aria-label={t.editor.channels}
              options={channelOptions}
              value={values.channels}
              onChange={(v) => set('channels', v as RoutingChannel[])}
            />
          </Field>
          <Field label={t.editor.ticketTypes}>
            <MultiSelect
              {...multi}
              aria-label={t.editor.ticketTypes}
              options={options.ticketTypes}
              value={values.ticketTypeIds}
              onChange={(v) => set('ticketTypeIds', v)}
            />
          </Field>
          <Field label={t.editor.tags}>
            <TagInput value={values.tags} suggestions={options.tags} onChange={(v) => set('tags', v)} t={t} />
          </Field>
          <Field label={t.editor.priorities}>
            <MultiSelect
              {...multi}
              aria-label={t.editor.priorities}
              options={priorityOptions}
              value={values.priorities}
              onChange={(v) => set('priorities', v as RoutingPriority[])}
            />
          </Field>
          <Field label={t.editor.teams}>
            <MultiSelect
              {...multi}
              aria-label={t.editor.teams}
              options={options.teams}
              value={values.departmentIds}
              onChange={(v) => set('departmentIds', v)}
            />
          </Field>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="font-medium">{t.editor.actionsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.editor.actionsHint}</p>
          </div>
          <Field label={t.editor.team}>
            <KeepSelect
              value={values.departmentId}
              options={options.teams}
              keepLabel={t.editor.keep}
              label={t.editor.team}
              onChange={(v) => set('departmentId', v)}
            />
          </Field>
          <Field label={t.editor.assignee}>
            <KeepSelect
              value={values.assigneeId}
              options={options.members}
              keepLabel={t.editor.keep}
              label={t.editor.assignee}
              onChange={(v) => set('assigneeId', v)}
            />
          </Field>
          <Field label={t.editor.priority}>
            <KeepSelect
              value={values.priority}
              options={priorityOptions}
              keepLabel={t.editor.keep}
              label={t.editor.priority}
              onChange={(v) => set('priority', v as RoutingPriority | null)}
            />
          </Field>
          <Field label={t.editor.addTags}>
            <TagInput value={values.addTags} suggestions={options.tags} onChange={(v) => set('addTags', v)} t={t} />
          </Field>
          {error === 'noAction' && <InfoBanner variant="warning">{t.editor.noAction}</InfoBanner>}
        </section>
      </div>
      <SheetFooter className="border-t px-6 py-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {t.editor.cancel}
        </Button>
        <Button type="submit" disabled={saving} data-testid="routing-rule-save">
          {t.editor.save}
        </Button>
      </SheetFooter>
    </form>
  );
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** A single value or "don't change". */
function KeepSelect({
  value,
  options,
  keepLabel,
  label,
  onChange,
}: Readonly<{
  value: string | null;
  options: MultiSelectOption[];
  keepLabel: string;
  label: string;
  onChange: (value: string | null) => void;
}>) {
  return (
    <Select value={value ?? KEEP} onValueChange={(v) => onChange(v === KEEP ? null : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KEEP}>{keepLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Free-text tags with the workspace's tags in use as suggestions. */
function TagInput({
  value,
  suggestions,
  onChange,
  t,
}: Readonly<{ value: string[]; suggestions: string[]; onChange: (value: string[]) => void; t: Strings }>) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const add = () => {
    const next = cleanTags([...value, draft]);
    setDraft('');
    if (next.length !== value.length) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <SoftBadge key={tag} tone="neutral" className="gap-1">
              {tag}
              <button
                type="button"
                className="rounded-sm opacity-70 hover:opacity-100"
                aria-label={t.editor.removeTag.replace('{tag}', tag)}
                onClick={() => onChange(value.filter((v) => v !== tag))}
              >
                <X className="h-3 w-3" />
              </button>
            </SoftBadge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          list={listId}
          maxLength={50}
          placeholder={t.editor.tagsPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="button" variant="outline" onClick={add} disabled={!draft.trim()}>
          {t.editor.addTag}
        </Button>
      </div>
      <datalist id={listId}>
        {suggestions.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}
