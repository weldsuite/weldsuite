/**
 * Create / edit one service catalogue item in a side sheet: the item itself,
 * its form (a customer ticket type) and routing, who can see it, the ordered
 * approval steps and the fulfilment tasks. Saving hands the values back; the
 * page sends them to `/api/desk/catalog`.
 */

import { useId, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { LucideDynamicIcon } from '@weldsuite/ui/components/lucide-dynamic-icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { CompanyMultiPicker } from '@/app/welddesk/components/company-multi-picker';
import type { DeskCatalogItem } from '@/hooks/queries/use-desk-catalog-queries';
import {
  CATALOG_ICONS,
  CATALOG_PRIORITIES,
  MAX_STEPS,
  MAX_TASKS,
  emptyCatalogValues,
  emptyStep,
  emptyTask,
  itemToValues,
  moveEntry,
  validateCatalogValues,
  type CatalogFormError,
  type CatalogFormValues,
  type CatalogStepValues,
  type CatalogTaskValues,
} from './catalog-form';

type Strings = ReturnType<typeof getTranslations<'deskCatalog'>>['settings']['editor'];

export interface CatalogOption {
  value: string;
  label: string;
}

/** What the pickers offer. */
export interface CatalogEditorOptions {
  /** Active customer ticket types. */
  ticketTypes: CatalogOption[];
  teams: CatalogOption[];
  members: CatalogOption[];
  /** Categories already in use. */
  categories: string[];
}

export interface CatalogItemEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item to edit; null creates one. */
  item: DeskCatalogItem | null;
  options: CatalogEditorOptions;
  saving: boolean;
  /** Resolves true when saved (the sheet closes), false to stay open. */
  onSave: (values: CatalogFormValues) => Promise<boolean>;
}

export function CatalogItemEditor({ open, onOpenChange, item, options, saving, onSave }: Readonly<CatalogItemEditorProps>) {
  const t = getTranslations('deskCatalog').settings.editor;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="catalog-item-editor">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{item ? t.editTitle : t.createTitle}</SheetTitle>
          <SheetDescription>{t.description}</SheetDescription>
        </SheetHeader>
        {open && (
          <CatalogItemForm
            key={item?.id ?? 'new'}
            item={item}
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

const DEFAULT = '__default__';

function errorMessage(error: CatalogFormError, t: Strings): string {
  switch (error) {
    case 'nameRequired':
      return t.nameRequired;
    case 'typeRequired':
      return t.typeRequired;
    case 'stepApprover':
      return t.stepApprover;
    case 'taskTitle':
      return t.taskTitleRequired;
    case 'tooManySteps':
      return t.tooManySteps.replace('{max}', String(MAX_STEPS));
    case 'tooManyTasks':
      return t.tooManyTasks.replace('{max}', String(MAX_TASKS));
  }
}

function CatalogItemForm({
  item,
  options,
  saving,
  onSave,
  onClose,
  t,
}: Readonly<{
  item: DeskCatalogItem | null;
  options: CatalogEditorOptions;
  saving: boolean;
  onSave: (values: CatalogFormValues) => Promise<boolean>;
  onClose: () => void;
  t: Strings;
}>) {
  const [values, setValues] = useState<CatalogFormValues>(() => (item ? itemToValues(item) : emptyCatalogValues()));
  const [error, setError] = useState<CatalogFormError | null>(null);
  const categoryListId = useId();
  const set = <K extends keyof CatalogFormValues>(key: K, value: CatalogFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const updateStep = (index: number, patch: Partial<CatalogStepValues>) =>
    set(
      'approvalSteps',
      values.approvalSteps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  const updateTask = (index: number, patch: Partial<CatalogTaskValues>) =>
    set(
      'fulfilmentTasks',
      values.fulfilmentTasks.map((task, i) => (i === index ? { ...task, ...patch } : task)),
    );

  const submit = async () => {
    const problem = validateCatalogValues(values);
    setError(problem);
    if (problem) return;
    if (await onSave(values)) onClose();
  };

  // A form that was switched off or removed keeps showing under its id.
  const typeOptions = options.ticketTypes.some((o) => o.value === values.ticketTypeId) || !values.ticketTypeId
    ? options.ticketTypes
    : [...options.ticketTypes, { value: values.ticketTypeId, label: values.ticketTypeId }];

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="catalog-item-form"
    >
      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <section className="space-y-4">
          <h3 className="font-medium">{t.basicsTitle}</h3>
          <div className="space-y-2">
            <Label htmlFor="catalog-item-name">{t.name}</Label>
            <Input
              id="catalog-item-name"
              value={values.name}
              maxLength={255}
              placeholder={t.namePlaceholder}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={error === 'nameRequired'}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-item-summary">{t.summary}</Label>
            <Input
              id="catalog-item-summary"
              value={values.summary}
              maxLength={500}
              placeholder={t.summaryPlaceholder}
              onChange={(e) => set('summary', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-item-description">{t.itemDescription}</Label>
            <Textarea
              id="catalog-item-description"
              rows={3}
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t.itemDescriptionHint}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="catalog-item-category">{t.category}</Label>
              <Input
                id="catalog-item-category"
                list={categoryListId}
                value={values.category}
                maxLength={100}
                placeholder={t.categoryPlaceholder}
                onChange={(e) => set('category', e.target.value)}
              />
              <datalist id={categoryListId}>
                {options.categories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label>{t.icon}</Label>
              <Select value={values.icon || DEFAULT} onValueChange={(v) => set('icon', v === DEFAULT ? '' : v)}>
                <SelectTrigger aria-label={t.icon}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>{t.noIcon}</SelectItem>
                  {CATALOG_ICONS.map((icon) => (
                    <SelectItem key={icon} value={icon}>
                      <span className="flex items-center gap-2">
                        <LucideDynamicIcon name={icon} className="h-4 w-4" />
                        {t.icons[icon]}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-item-estimate">{t.deliveryEstimate}</Label>
            <Input
              id="catalog-item-estimate"
              value={values.deliveryEstimate}
              maxLength={100}
              placeholder={t.deliveryEstimatePlaceholder}
              onChange={(e) => set('deliveryEstimate', e.target.value)}
            />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="font-medium">{t.formTitle}</h3>
          <Field label={t.ticketType}>
            <Select value={values.ticketTypeId || undefined} onValueChange={(v) => set('ticketTypeId', v)}>
              <SelectTrigger aria-label={t.ticketType} aria-invalid={error === 'typeRequired'}>
                <SelectValue placeholder={t.ticketTypePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {values.ticketTypeId && (
              <Link href="/settings/apps/welddesk/ticket-types" className="text-sm text-primary underline-offset-2 hover:underline">
                {t.editFormLink}
              </Link>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.team}>
              <DefaultSelect
                value={values.departmentId}
                options={options.teams}
                defaultLabel={t.teamDefault}
                label={t.team}
                onChange={(v) => set('departmentId', v)}
              />
            </Field>
            <Field label={t.priority}>
              <DefaultSelect
                value={values.priority}
                options={CATALOG_PRIORITIES.map((p) => ({ value: p, label: t.priorities[p] }))}
                defaultLabel={t.priorityDefault}
                label={t.priority}
                onChange={(v) => set('priority', v as CatalogFormValues['priority'])}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="font-medium">{t.audienceTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.audienceHint}</p>
          </div>
          <CompanyMultiPicker value={values.audienceCompanyIds} onChange={(ids) => set('audienceCompanyIds', ids)} />
        </section>

        <section className="space-y-3" data-testid="catalog-steps">
          <div>
            <h3 className="font-medium">{t.approvalTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.approvalHint}</p>
          </div>
          {values.approvalSteps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              count={values.approvalSteps.length}
              options={options}
              t={t}
              onChange={(patch) => updateStep(index, patch)}
              onMove={(by) => set('approvalSteps', moveEntry(values.approvalSteps, index, by))}
              onRemove={() => set('approvalSteps', values.approvalSteps.filter((_, i) => i !== index))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={values.approvalSteps.length >= MAX_STEPS}
            onClick={() => set('approvalSteps', [...values.approvalSteps, emptyStep()])}
            data-testid="catalog-add-step"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t.addStep}
          </Button>
        </section>

        <section className="space-y-3" data-testid="catalog-tasks">
          <div>
            <h3 className="font-medium">{t.tasksTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.tasksHint}</p>
          </div>
          {values.fulfilmentTasks.map((task, index) => (
            <TaskRow
              key={task.id}
              task={task}
              index={index}
              options={options}
              t={t}
              onChange={(patch) => updateTask(index, patch)}
              onRemove={() => set('fulfilmentTasks', values.fulfilmentTasks.filter((_, i) => i !== index))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={values.fulfilmentTasks.length >= MAX_TASKS}
            onClick={() => set('fulfilmentTasks', [...values.fulfilmentTasks, emptyTask()])}
            data-testid="catalog-add-task"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t.addTask}
          </Button>
        </section>

        <section className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="catalog-item-active">{t.active}</Label>
            <p className="text-sm text-muted-foreground">{t.activeHint}</p>
          </div>
          <Switch id="catalog-item-active" checked={values.isActive} onCheckedChange={(on) => set('isActive', on)} />
        </section>

        {error && <InfoBanner variant="warning">{errorMessage(error, t)}</InfoBanner>}
      </div>
      <SheetFooter className="border-t px-6 py-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={saving} data-testid="catalog-item-save">
          {t.save}
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

/** One value or the default of the form's ticket type. */
function DefaultSelect({
  value,
  options,
  defaultLabel,
  label,
  onChange,
}: Readonly<{
  value: string;
  options: CatalogOption[];
  defaultLabel: string;
  label: string;
  onChange: (value: string) => void;
}>) {
  return (
    <Select value={value || DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? '' : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StepRow({
  step,
  index,
  count,
  options,
  t,
  onChange,
  onMove,
  onRemove,
}: Readonly<{
  step: CatalogStepValues;
  index: number;
  count: number;
  options: CatalogEditorOptions;
  t: Strings;
  onChange: (patch: Partial<CatalogStepValues>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const number = String(index + 1);
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="catalog-step-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t.stepLabel.replace('{number}', number)}</span>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t.moveStepUp.replace('{number}', number)}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t.moveStepDown.replace('{number}', number)}>
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t.removeStep.replace('{number}', number)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t.stepName}</Label>
          <Input
            value={step.name}
            maxLength={255}
            placeholder={t.stepNamePlaceholder}
            aria-label={`${t.stepName} ${number}`}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>{t.approver}</Label>
          <Select
            value={step.approverType}
            onValueChange={(v) => onChange({ approverType: v as CatalogStepValues['approverType'] })}
          >
            <SelectTrigger aria-label={`${t.approver} ${number}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">{t.approverMember}</SelectItem>
              <SelectItem value="team_manager">{t.approverManager}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {step.approverType === 'member' ? (
        <Select value={step.approverId || undefined} onValueChange={(v) => onChange({ approverId: v })}>
          <SelectTrigger aria-label={`${t.pickMember} ${number}`}>
            <SelectValue placeholder={t.pickMember} />
          </SelectTrigger>
          <SelectContent>
            {options.members.map((member) => (
              <SelectItem key={member.value} value={member.value}>
                {member.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <DefaultSelect
          value={step.departmentId}
          options={options.teams}
          defaultLabel={t.requestTeam}
          label={`${t.pickTeam} ${number}`}
          onChange={(v) => onChange({ departmentId: v })}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  index,
  options,
  t,
  onChange,
  onRemove,
}: Readonly<{
  task: CatalogTaskValues;
  index: number;
  options: CatalogEditorOptions;
  t: Strings;
  onChange: (patch: Partial<CatalogTaskValues>) => void;
  onRemove: () => void;
}>) {
  const number = String(index + 1);
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="catalog-task-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t.taskLabel.replace('{number}', number)}</span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t.removeTask.replace('{number}', number)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        value={task.title}
        maxLength={255}
        placeholder={t.taskTitle}
        aria-label={`${t.taskTitle} ${number}`}
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <Textarea
        rows={2}
        value={task.description}
        placeholder={t.taskDescription}
        aria-label={`${t.taskDescription} ${number}`}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t.assignee}</Label>
          <DefaultSelect
            value={task.assigneeId}
            options={options.members}
            defaultLabel={t.ticketOwner}
            label={`${t.assignee} ${number}`}
            onChange={(v) => onChange({ assigneeId: v })}
          />
        </div>
        <div className="space-y-2">
          <Label>{t.dueInDays}</Label>
          <Input
            type="number"
            min={0}
            max={365}
            inputMode="numeric"
            value={task.dueInDays}
            aria-label={`${t.dueInDays} ${number}`}
            onChange={(e) => onChange({ dueInDays: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
