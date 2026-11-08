/**
 * Create / edit one SLA policy in a side sheet. The form only offers what the
 * SLA engine reads (see `sla-form.ts`).
 */

import { useMemo } from 'react';
import { useFieldArray, useForm, useWatch, type Control, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import { useDeskAttributeOptions } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import {
  useCreateDeskSla,
  useUpdateDeskSla,
  type DeskSlaPolicy,
} from '@/hooks/queries/use-desk-sla-queries';
import {
  SLA_CHANNELS,
  SLA_CONDITION_FIELDS,
  SLA_FIELD_OPERATORS,
  SLA_METRICS,
  SLA_PRIORITIES,
  SLA_WEEKDAYS,
  createSlaFormSchema,
  isConditionField,
  newPolicyValues,
  policyToValues,
  timezoneOptions,
  valuesToPayload,
  type SlaConditionField,
  type SlaFormValues,
  type SlaOperator,
} from './sla-form';

type Strings = ReturnType<typeof getTranslations<'helpdesk'>>['slaPolicies'];

export interface SlaPolicyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The policy to edit; null creates one. */
  policy: DeskSlaPolicy | null;
  /** Every policy, to suggest the next order and warn about a second default. */
  policies: DeskSlaPolicy[];
}

export function SlaPolicyEditor({ open, onOpenChange, policy, policies }: Readonly<SlaPolicyEditorProps>) {
  const t = getTranslations('helpdesk').slaPolicies;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="sla-policy-editor">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{policy ? t.editor.editTitle : t.editor.createTitle}</SheetTitle>
          <SheetDescription>{t.editor.description}</SheetDescription>
        </SheetHeader>
        {open && <SlaPolicyForm policy={policy} policies={policies} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function SlaPolicyForm({
  policy,
  policies,
  onClose,
}: Readonly<{ policy: DeskSlaPolicy | null; policies: DeskSlaPolicy[]; onClose: () => void }>) {
  const t = getTranslations('helpdesk').slaPolicies;
  const createSla = useCreateDeskSla();
  const updateSla = useUpdateDeskSla();

  const schema = useMemo(
    () =>
      createSlaFormSchema({
        nameRequired: t.validation.nameRequired,
        nameTooLong: t.validation.nameTooLong,
        priorityInvalid: t.validation.orderInvalid,
        timeInvalid: t.validation.timeInvalid,
        conditionValueRequired: t.validation.conditionValueRequired,
        noTargets: t.validation.noTargets,
        timeTooLong: t.validation.timeTooLong,
        timezoneRequired: t.validation.timezoneRequired,
        noOpenDay: t.validation.noOpenDay,
        closeBeforeOpen: t.validation.closeBeforeOpen,
        holidayDateRequired: t.validation.holidayDateRequired,
      }),
    [t],
  );

  const form = useForm<SlaFormValues>({
    resolver: zodResolver(schema),
    defaultValues: policy
      ? policyToValues(policy)
      : newPolicyValues(Math.max(-1, ...policies.map((p) => p.priority)) + 1),
  });

  const saving = createSla.isPending || updateSla.isPending;

  const onSubmit = async (values: SlaFormValues) => {
    const payload = valuesToPayload(values, policy);
    try {
      if (policy) {
        await updateSla.mutateAsync({ id: policy.id, ...payload });
        toast.success(t.toast.updated);
      } else {
        await createSla.mutateAsync(payload);
        toast.success(t.toast.created);
      }
      onClose();
    } catch {
      toast.error(t.toast.saveFailed);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="sla-policy-form"
      >
        <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
          <GeneralSection form={form} policy={policy} policies={policies} t={t} />
          <ConditionsSection form={form} t={t} />
          <TargetsSection form={form} t={t} />
          <WarningSection form={form} t={t} />
          <HoursSection form={form} t={t} />
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {t.editor.cancel}
          </Button>
          <Button type="submit" disabled={saving} data-testid="sla-policy-save">
            {saving ? t.editor.saving : t.editor.save}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  );
}

interface SectionProps {
  form: UseFormReturn<SlaFormValues>;
  t: Strings;
}

function Section({ title, description, children }: Readonly<{ title: string; description?: string; children: React.ReactNode }>) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function GeneralSection({
  form,
  policy,
  policies,
  t,
}: Readonly<SectionProps & { policy: DeskSlaPolicy | null; policies: DeskSlaPolicy[] }>) {
  const isDefault = useWatch({ control: form.control, name: 'isDefault' });
  const otherDefault = policies.find((p) => p.isDefault && p.isActive && p.id !== policy?.id);
  return (
    <Section title={t.general.title}>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.general.name}</FormLabel>
            <FormControl>
              <Input placeholder={t.general.namePlaceholder} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.general.descriptionLabel}</FormLabel>
            <FormControl>
              <Textarea rows={2} placeholder={t.general.descriptionPlaceholder} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="priority"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.general.order}</FormLabel>
            <FormControl>
              <Input inputMode="numeric" className="w-28" {...field} />
            </FormControl>
            <FormDescription>{t.general.orderHint}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="isActive"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between gap-4 space-y-0">
            <div className="space-y-1">
              <FormLabel>{t.general.active}</FormLabel>
              <FormDescription>{t.general.activeHint}</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="isDefault"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between gap-4 space-y-0">
            <div className="space-y-1">
              <FormLabel>{t.general.isDefault}</FormLabel>
              <FormDescription>{t.general.isDefaultHint}</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      {isDefault && otherDefault && (
        <InfoBanner variant="warning">{t.general.otherDefault.replace('{name}', otherDefault.name)}</InfoBanner>
      )}
    </Section>
  );
}

function ConditionsSection({ form, t }: Readonly<SectionProps>) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'conditions' });
  const isDefault = useWatch({ control: form.control, name: 'isDefault' });
  return (
    <Section title={t.conditions.title} description={t.conditions.description}>
      {isDefault ? (
        <InfoBanner variant="info">{t.conditions.defaultNote}</InfoBanner>
      ) : (
        <>
          {fields.length === 0 && <p className="text-sm text-muted-foreground">{t.conditions.empty}</p>}
          <ul className="space-y-3">
            {fields.map((row, index) => (
              <ConditionRow key={row.id} index={index} form={form} t={t} onRemove={() => remove(index)} />
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ field: 'priority', operator: 'equals', value: '' })}
            data-testid="sla-condition-add"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t.conditions.add}
          </Button>
        </>
      )}
    </Section>
  );
}

function ConditionRow({
  index,
  form,
  t,
  onRemove,
}: Readonly<SectionProps & { index: number; onRemove: () => void }>) {
  const field = useWatch({ control: form.control, name: `conditions.${index}.field` });
  const supported = isConditionField(field);
  const operators: SlaOperator[] = supported ? SLA_FIELD_OPERATORS[field] : ['equals', 'not_equals'];

  // Changing the field resets what no longer fits it.
  const onFieldChange = (next: string) => {
    form.setValue(`conditions.${index}.field`, next);
    const nextOperators = isConditionField(next) ? SLA_FIELD_OPERATORS[next] : operators;
    if (!nextOperators.includes(form.getValues(`conditions.${index}.operator`))) {
      form.setValue(`conditions.${index}.operator`, nextOperators[0]);
    }
    form.setValue(`conditions.${index}.value`, '');
  };

  return (
    <li className="space-y-2 rounded-lg border p-3" data-testid="sla-condition-row">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select value={field} onValueChange={onFieldChange}>
          <SelectTrigger aria-label={t.conditions.field}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SLA_CONDITION_FIELDS.map((key) => (
              <SelectItem key={key} value={key}>
                {t.conditions.fields[key]}
              </SelectItem>
            ))}
            {!supported && <SelectItem value={field}>{field}</SelectItem>}
          </SelectContent>
        </Select>
        <FormField
          control={form.control}
          name={`conditions.${index}.operator`}
          render={({ field: operator }) => (
            <Select value={operator.value} onValueChange={operator.onChange}>
              <SelectTrigger aria-label={t.conditions.operator}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {operators.map((op) => (
                  <SelectItem key={op} value={op}>
                    {operatorLabel(t, field, op)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t.conditions.remove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <FormField
        control={form.control}
        name={`conditions.${index}.value`}
        render={({ field: value }) => (
          <FormItem>
            <ConditionValue field={field} value={value.value} onChange={value.onChange} t={t} />
            <FormMessage />
          </FormItem>
        )}
      />
      {!supported && <p className="text-xs text-destructive">{t.conditions.unsupported}</p>}
    </li>
  );
}

/** "is" / "is not" read better than equals for ids, so the wording follows the field. */
function operatorLabel(t: Strings, field: string, operator: SlaOperator): string {
  if (field === 'tags' && operator === 'contains') return t.conditions.operators.hasTag;
  if (field === 'tags' && operator === 'not_equals') return t.conditions.operators.hasNoTag;
  if (field === 'priority' && operator === 'greater_than') return t.conditions.operators.higherThan;
  if (field === 'priority' && operator === 'less_than') return t.conditions.operators.lowerThan;
  return t.conditions.operators[operator];
}

function ConditionValue({
  field,
  value,
  onChange,
  t,
}: Readonly<{ field: string; value: string; onChange: (value: string) => void; t: Strings }>) {
  const { data: attributes } = useDeskAttributeOptions();
  const { data: members = [] } = useDeskWorkspaceMembers();

  const pick = (options: { value: string; label: string }[]) => {
    // A stored id the pickers no longer list (a removed type or member) stays selectable.
    const known = options.some((o) => o.value === value);
    return (
      <Select value={value} onValueChange={onChange}>
        <FormControl>
          <SelectTrigger aria-label={t.conditions.value}>
            <SelectValue placeholder={t.conditions.pick} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
          {value && !known && <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    );
  };

  switch (field as SlaConditionField) {
    case 'priority':
      return pick(SLA_PRIORITIES.map((p) => ({ value: p, label: t.priorities[p] })));
    case 'channel':
      return pick(SLA_CHANNELS.map((c) => ({ value: c, label: t.channels[c] })));
    case 'ticketTypeId':
      return pick((attributes?.ticketTypes ?? []).map((x) => ({ value: x.id, label: x.name })));
    case 'departmentId':
      return pick((attributes?.teams ?? []).map((x) => ({ value: x.id, label: x.name })));
    case 'assigneeId':
      return pick(
        members.filter((m) => m.status?.toUpperCase() !== 'REMOVED').map((m) => ({ value: m.userId, label: m.name })),
      );
    case 'tags':
      return (
        <>
          <FormControl>
            <Input
              list="sla-tag-suggestions"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={t.conditions.tagPlaceholder}
              aria-label={t.conditions.value}
            />
          </FormControl>
          <datalist id="sla-tag-suggestions">
            {(attributes?.tags ?? []).map((entry) => (
              <option key={entry.tag} value={entry.tag} />
            ))}
          </datalist>
        </>
      );
    default:
      return (
        <FormControl>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field === 'email' ? t.conditions.emailPlaceholder : t.conditions.value}
            aria-label={t.conditions.value}
          />
        </FormControl>
      );
  }
}

function TimeCell({
  control,
  name,
  t,
  label,
}: Readonly<{ control: Control<SlaFormValues>; name: `targets.${string}` | 'warnBefore'; t: Strings; label: string }>) {
  const hours = `${name}.hours` as never;
  const minutes = `${name}.minutes` as never;
  return (
    <div className="flex items-center gap-1.5">
      <FormField
        control={control}
        name={hours}
        render={({ field }) => (
          <FormItem className="space-y-0">
            <FormControl>
              <Input
                inputMode="numeric"
                className="w-16"
                placeholder="0"
                aria-label={`${label}: ${t.targets.hours}`}
                {...field}
                value={field.value as string}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <span className="text-sm text-muted-foreground">{t.targets.hoursShort}</span>
      <FormField
        control={control}
        name={minutes}
        render={({ field }) => (
          <FormItem className="space-y-0">
            <FormControl>
              <Input
                inputMode="numeric"
                className="w-16"
                placeholder="0"
                aria-label={`${label}: ${t.targets.minutes}`}
                {...field}
                value={field.value as string}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <span className="text-sm text-muted-foreground">{t.targets.minutesShort}</span>
    </div>
  );
}

function TargetsSection({ form, t }: Readonly<SectionProps>) {
  const targetsError = (form.formState.errors.targets as { message?: string } | undefined)?.message;
  const cellErrors = form.formState.errors.targets as
    | Record<string, Record<string, { hours?: { message?: string } } | undefined> | undefined>
    | undefined;
  return (
    <Section title={t.targets.title} description={t.targets.description}>
      <InfoBanner variant="tip">{t.targets.mediumNote}</InfoBanner>
      {SLA_METRICS.map((metric) => (
        <div key={metric} className="space-y-3 rounded-lg border p-4" data-testid={`sla-targets-${metric}`}>
          <div>
            <p className="text-sm font-medium">{t.targets.metrics[metric].title}</p>
            <p className="text-xs text-muted-foreground">{t.targets.metrics[metric].hint}</p>
          </div>
          <div className="space-y-2">
            {SLA_PRIORITIES.map((priority) => (
              <div key={priority} className="flex items-center justify-between gap-4">
                <span className="text-sm">{t.priorities[priority]}</span>
                <div className="flex flex-col items-end gap-1">
                  <TimeCell
                    control={form.control}
                    name={`targets.${metric}.${priority}`}
                    t={t}
                    label={`${t.targets.metrics[metric].title} ${t.priorities[priority]}`}
                  />
                  {cellErrors?.[metric]?.[priority]?.hours?.message && (
                    <p className="text-xs text-destructive">{cellErrors[metric]?.[priority]?.hours?.message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t.targets.calendarNote}</p>
      {targetsError && <p className="text-sm text-destructive">{targetsError}</p>}
    </Section>
  );
}

function WarningSection({ form, t }: Readonly<SectionProps>) {
  return (
    <Section title={t.warning.title} description={t.warning.description}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t.warning.label}</span>
        <TimeCell control={form.control} name="warnBefore" t={t} label={t.warning.label} />
      </div>
    </Section>
  );
}

function HoursSection({ form, t }: Readonly<SectionProps>) {
  const mode = useWatch({ control: form.control, name: 'operationalHours' });
  const timezone = useWatch({ control: form.control, name: 'timezone' });
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const holidays = useFieldArray({ control: form.control, name: 'holidays' });
  const daysError = (form.formState.errors.days as { message?: string } | undefined)?.message;

  const options: { value: 'business' | '24x7' | 'custom'; title: string; description: string }[] = [
    { value: '24x7', title: t.hours.options.always.title, description: t.hours.options.always.description },
    { value: 'business', title: t.hours.options.workspace.title, description: t.hours.options.workspace.description },
    { value: 'custom', title: t.hours.options.custom.title, description: t.hours.options.custom.description },
  ];

  return (
    <Section title={t.hours.title} description={t.hours.description}>
      <FormField
        control={form.control}
        name="operationalHours"
        render={({ field }) => (
          <RadioGroup value={field.value} onValueChange={field.onChange} className="space-y-2">
            {options.map((option) => (
              <label
                key={option.value}
                htmlFor={`sla-hours-${option.value}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
              >
                <RadioGroupItem id={`sla-hours-${option.value}`} value={option.value} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      />

      {mode === 'custom' && (
        <div className="space-y-4" data-testid="sla-custom-hours">
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t.hours.timezone}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="max-h-72">
                    {zones.map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {zone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-2">
            {SLA_WEEKDAYS.map((day) => (
              <DayRow key={day} day={day} form={form} t={t} />
            ))}
            {daysError && <p className="text-sm text-destructive">{daysError}</p>}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t.hours.holidays.title}</p>
            <p className="text-xs text-muted-foreground">{t.hours.holidays.description}</p>
            {holidays.fields.map((row, index) => (
              <div key={row.id} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto_auto]" data-testid="sla-holiday-row">
                <FormField
                  control={form.control}
                  name={`holidays.${index}.date`}
                  render={({ field }) => (
                    <FormItem className="space-y-0">
                      <FormControl>
                        <Input type="date" aria-label={t.hours.holidays.date} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`holidays.${index}.name`}
                  render={({ field }) => (
                    <FormItem className="space-y-0">
                      <FormControl>
                        <Input placeholder={t.hours.holidays.name} aria-label={t.hours.holidays.name} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`holidays.${index}.isRecurring`}
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                      </FormControl>
                      <FormLabel className="text-sm font-normal">{t.hours.holidays.recurring}</FormLabel>
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => holidays.remove(index)}
                  aria-label={t.hours.holidays.remove}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => holidays.append({ date: '', name: '', isRecurring: false })}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t.hours.holidays.add}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function DayRow({ day, form, t }: Readonly<SectionProps & { day: (typeof SLA_WEEKDAYS)[number] }>) {
  const isOpen = useWatch({ control: form.control, name: `days.${day}.isOpen` });
  const closeError = (
    form.formState.errors.days as Record<string, { closeTime?: { message?: string } } | undefined> | undefined
  )?.[day]?.closeTime?.message;
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[7rem_auto_1fr] items-center gap-3">
        <span className="text-sm">{t.hours.weekdays[day]}</span>
        <FormField
          control={form.control}
          name={`days.${day}.isOpen`}
          render={({ field }) => (
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} aria-label={t.hours.weekdays[day]} />
            </FormControl>
          )}
        />
        {isOpen ? (
          <div className="flex items-center gap-2">
            <FormField
              control={form.control}
              name={`days.${day}.openTime`}
              render={({ field }) => (
                <FormControl>
                  <Input type="time" className="w-28" aria-label={`${t.hours.weekdays[day]}: ${t.hours.from}`} {...field} />
                </FormControl>
              )}
            />
            <span className="text-sm text-muted-foreground">{t.hours.to}</span>
            <FormField
              control={form.control}
              name={`days.${day}.closeTime`}
              render={({ field }) => (
                <FormControl>
                  <Input type="time" className="w-28" aria-label={`${t.hours.weekdays[day]}: ${t.hours.to}`} {...field} />
                </FormControl>
              )}
            />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t.hours.closed}</span>
        )}
      </div>
      {closeError && <p className="text-xs text-destructive">{closeError}</p>}
    </div>
  );
}
