/**
 * The create and edit dialog of a RAID item. One shell (the stock shadcn
 * dialog header, body and footer) and one form per kind; every form is React
 * Hook Form with the shared request schemas behind `zodResolver`, and every
 * save goes through `useItemSave`.
 */

import { useMemo, type ReactNode } from 'react';
import { Controller, useForm, type Control, type FieldPath, type FieldValues, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { FieldGroup, FieldSeparator } from '@weldsuite/ui/components/field';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  ASSUMPTION_CONFIDENCES,
  DEPENDENCY_DIRECTIONS,
  DEPENDENCY_PARTY_TYPES,
  ISSUE_SEVERITIES,
} from '@weldsuite/app-api-client/schemas/project-control';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import {
  useCreateControlLink,
  useCreateRaidItem,
  useCreateRaidTask,
  useProjectMilestones,
  useRiskCategories,
  useUpdateRaidItem,
} from '@/hooks/queries/use-project-control-queries';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { DEFAULT_REVIEW_INTERVAL_DAYS, reviewIntervalLabel, riskBand, riskScore } from '../_lib/risk';
import { reviewEveryLabel, riskCategoryOptions } from '../_lib/copy';
import { statusesOf } from '../_lib/raid';
import {
  assumptionFormSchema,
  assumptionValuesFromItem,
  buildCreateBody,
  buildUpdateBody,
  defaultAssumptionValues,
  defaultDependencyValues,
  defaultIssueValues,
  defaultRiskValues,
  dependencyFormSchema,
  dependencyValuesFromItem,
  issueFormSchema,
  issueValuesFromItem,
  parseCreateBody,
  parseUpdateBody,
  raidResolverOptions,
  riskFormSchema,
  riskValuesFromItem,
  type AssumptionFormValues,
  type DependencyFormValues,
  type IssueFormValues,
  type RaidFormValues,
  type RiskFormValues,
} from '../_lib/form';
import { CheckboxField, DateField, NumberField, SelectField, TextAreaField, TextField, type SelectOption } from './form-fields';
import { RatingField, ScoreField, StrategyPicker } from './rating-controls';
import { useRaid } from './raid-context';

export type ItemDialogState = { mode: 'create'; kind: RaidKind } | { mode: 'edit'; item: RaidItem };

interface ItemDialogProps {
  state: ItemDialogState | null;
  onClose: () => void;
}

function kindOfState(state: ItemDialogState): RaidKind {
  return state.mode === 'create' ? state.kind : state.item.kind;
}

/** The dialog; render it once and hand it the item (or kind) to work on. */
export function ItemDialog({ state, onClose }: Readonly<ItemDialogProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const kind = state ? kindOfState(state) : null;
  const code = state?.mode === 'edit' ? state.item.code : null;

  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={cn('max-h-[92vh] overflow-y-auto', kind === 'risk' ? 'sm:max-w-4xl' : 'sm:max-w-2xl')}
        {...(code ? {} : { 'aria-describedby': undefined })}
      >
        {state && kind ? (
          <>
            <DialogHeader>
              <DialogTitle>{state.mode === 'create' ? copy.form.createTitle[kind] : copy.form.editTitle[kind]}</DialogTitle>
              {code ? <DialogDescription>{code}</DialogDescription> : null}
            </DialogHeader>
            <ItemForm key={state.mode === 'edit' ? state.item.id : `new-${kind}`} state={state} onClose={onClose} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ItemForm({ state, onClose }: Readonly<{ state: ItemDialogState; onClose: () => void }>) {
  const edit = state.mode === 'edit' ? state.item : null;
  const kind = state.mode === 'create' ? state.kind : state.item.kind;
  switch (kind) {
    case 'risk':
      return <RiskForm edit={edit} onClose={onClose} />;
    case 'assumption':
      return <AssumptionForm edit={edit} onClose={onClose} />;
    case 'issue':
      return <IssueForm edit={edit} onClose={onClose} />;
    case 'dependency':
      return <DependencyForm edit={edit} onClose={onClose} />;
  }
}

// ── Saving ──────────────────────────────────────────────────────────────────

/** Create or update an item from a form of its kind, then close. A new risk can also get its task and milestone link. */
function useItemSave(kind: RaidKind, edit: RaidItem | null, onClose: () => void) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, select, abilities } = useRaid();
  const createItem = useCreateRaidItem();
  const updateItem = useUpdateRaidItem();
  const createTask = useCreateRaidTask(projectId);
  const createLink = useCreateControlLink();
  const pending = createItem.isPending || updateItem.isPending || createTask.isPending || createLink.isPending;

  /** The optional extras of a new risk: its mitigation task and the milestone it threatens. */
  const createRiskExtras = async (created: RaidItem, values: RiskFormValues) => {
    if (values.createTask && abilities.createTasks) {
      try {
        await createTask.mutateAsync({
          id: created.id,
          data: { title: format(copy.form.mitigationTaskTitle, { title: created.title }), assigneeId: values.ownerId ?? null },
        });
      } catch {
        toast.warning(copy.toasts.createdWithoutTask);
      }
    }
    if (values.milestoneId) {
      try {
        await createLink.mutateAsync({
          fromType: 'raid_item',
          fromId: created.id,
          toType: 'milestone',
          toId: values.milestoneId,
          relation: 'threatens',
        });
      } catch {
        toast.warning(copy.toasts.createdWithoutMilestone);
      }
    }
  };

  const save = async (values: RaidFormValues) => {
    try {
      if (edit) {
        const body = parseUpdateBody(edit.kind, buildUpdateBody(edit, values));
        if (!body) {
          toast.error(copy.toasts.updateFailed);
          return;
        }
        await updateItem.mutateAsync({ id: edit.id, data: body });
        toast.success(copy.toasts.updated);
        onClose();
        return;
      }

      const body = parseCreateBody(buildCreateBody(kind, projectId, values));
      if (!body) {
        toast.error(copy.toasts.createFailed);
        return;
      }
      const created = (await createItem.mutateAsync(body)).data;
      toast.success(copy.toasts.created[kind]);
      if (kind === 'risk') await createRiskExtras(created, values as RiskFormValues);
      select(created.id);
      onClose();
    } catch {
      toast.error(edit ? copy.toasts.updateFailed : copy.toasts.createFailed);
    }
  };

  return { save, pending, submitLabel: edit ? copy.form.save : copy.form.submit[kind] };
}

/** The `zodResolver` options that put the validation messages in the user's language. */
function useResolverOptions() {
  const { t, format } = useI18n();
  const validation = t.projects.raid.validation;
  return useMemo(() => raidResolverOptions(validation, format), [validation, format]);
}

/** The owner a new item starts with: the signed-in member, when the project has them. */
function useDefaultOwner(): string | null {
  const { userId } = useAuth();
  const { memberOf } = useRaid();
  return userId && memberOf(userId) ? userId : null;
}

// ── Shell ───────────────────────────────────────────────────────────────────

interface FormShellProps<T extends FieldValues> {
  form: UseFormReturn<T>;
  onSubmit: (values: T) => void | Promise<void>;
  pending: boolean;
  submitLabel: string;
  children: ReactNode;
}

/** The form element: the fields in a `FieldGroup`, then the dialog footer with Cancel and the submit button. */
function FormShell<T extends FieldValues>({ form, onSubmit, pending, submitLabel, children }: Readonly<FormShellProps<T>>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="grid gap-8">
      <FieldGroup>{children}</FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            {t.common.actions.cancel}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {pending ? copy.form.saving : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function useMemberOptions(): SelectOption[] {
  const { members } = useRaid();
  return members.map((member) => ({ value: member.userId, label: member.name }));
}

function StatusField<T extends FieldValues>({
  control,
  kind,
  inline,
}: Readonly<{ control: Control<T>; kind: RaidKind; inline?: boolean }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const labels = copy.status[kind] as Record<string, string>;
  return (
    <SelectField
      control={control}
      name={'status' as FieldPath<T>}
      label={copy.form.status}
      options={statusesOf(kind).map((status) => ({ value: status, label: labels[status] ?? status }))}
      inline={inline}
    />
  );
}

// ── Risk ────────────────────────────────────────────────────────────────────

function RiskForm({ edit, onClose }: Readonly<{ edit: RaidItem | null; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, abilities } = useRaid();
  const members = useMemberOptions();
  const resolverOptions = useResolverOptions();
  const ownerDefault = useDefaultOwner();
  const { save, pending, submitLabel } = useItemSave('risk', edit, onClose);
  const milestones = useProjectMilestones(projectId, !edit);

  const form = useForm<RiskFormValues>({
    resolver: zodResolver(riskFormSchema, resolverOptions),
    defaultValues: edit ? riskValuesFromItem(edit) : defaultRiskValues(ownerDefault),
  });
  const [probability, impact] = form.watch(['probability', 'impact']);
  const band = riskBand(riskScore(probability ?? 3, impact ?? 3));
  const { data: categories } = useRiskCategories();
  const categoryOptions = useMemo(() => riskCategoryOptions(copy, categories, edit?.category), [copy, categories, edit?.category]);
  const reviewHint = format(copy.form.reviewDefault, {
    interval: reviewEveryLabel(copy, reviewIntervalLabel(DEFAULT_REVIEW_INTERVAL_DAYS[band]), format),
  });

  return (
    <FormShell form={form} onSubmit={save} pending={pending} submitLabel={submitLabel}>
      <div className="grid gap-7 md:grid-cols-[minmax(0,1fr)_auto_22rem]">
        <FieldGroup>
          <TextField control={form.control} name="title" label={copy.form.title} placeholder={copy.form.titlePlaceholder.risk} autoFocus />
          <TextAreaField control={form.control} name="description" label={copy.form.description.risk} rows={4} />
          <TextAreaField control={form.control} name="trigger" label={copy.form.trigger} placeholder={copy.form.triggerPlaceholder} rows={3} />
          <Controller
            control={form.control}
            name="strategy"
            render={({ field }) => <StrategyPicker value={field.value} onChange={field.onChange} />}
          />
          {!edit && abilities.createTasks ? <CheckboxField control={form.control} name="createTask" label={copy.form.alsoCreateTask} /> : null}
        </FieldGroup>

        <Separator orientation="vertical" className="hidden md:block" />

        <FieldGroup>
          <FieldGroup>
            {edit ? (
              <ScoreField probability={edit.probability} impact={edit.impact} hint={copy.form.ratingHint} />
            ) : (
              <>
                <RatingField control={form.control} name="probability" label={copy.form.probability} kind="probability" />
                <RatingField control={form.control} name="impact" label={copy.form.impact} kind="impact" />
                <ScoreField probability={probability} impact={impact} />
              </>
            )}
            <SelectField control={form.control} name="ownerId" label={copy.form.owner} noneLabel={copy.form.noOwner} options={members} inline />
            <SelectField
              control={form.control}
              name="category"
              label={copy.form.category}
              noneLabel={copy.form.noCategory}
              options={categoryOptions}
              inline
            />
            <DateField control={form.control} name="dueDate" label={copy.form.dueDate.risk} description={edit ? undefined : reviewHint} inline />
            {edit ? <StatusField control={form.control} kind="risk" inline /> : null}
          </FieldGroup>
          <FieldSeparator>{copy.form.ifItHappens}</FieldSeparator>
          <FieldGroup>
            <NumberField control={form.control} name="scheduleImpactDays" label={copy.form.delayDays} step={1} inline />
            <NumberField control={form.control} name="costImpact" label={copy.form.cost} step="any" inline />
            {edit ? null : (
              <SelectField
                control={form.control}
                name="milestoneId"
                label={copy.form.milestone}
                noneLabel={copy.form.noMilestone}
                options={(milestones.data ?? []).map((milestone) => ({ value: milestone.id, label: milestone.name }))}
                inline
              />
            )}
          </FieldGroup>
        </FieldGroup>
      </div>
    </FormShell>
  );
}

// ── Assumption ──────────────────────────────────────────────────────────────

function AssumptionForm({ edit, onClose }: Readonly<{ edit: RaidItem | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const members = useMemberOptions();
  const resolverOptions = useResolverOptions();
  const ownerDefault = useDefaultOwner();
  const { save, pending, submitLabel } = useItemSave('assumption', edit, onClose);

  const form = useForm<AssumptionFormValues>({
    resolver: zodResolver(assumptionFormSchema, resolverOptions),
    defaultValues: edit ? assumptionValuesFromItem(edit) : defaultAssumptionValues(ownerDefault),
  });

  return (
    <FormShell form={form} onSubmit={save} pending={pending} submitLabel={submitLabel}>
      <TextField control={form.control} name="title" label={copy.form.title} placeholder={copy.form.titlePlaceholder.assumption} autoFocus />
      <TextAreaField control={form.control} name="description" label={copy.form.description.assumption} />
      <TextAreaField control={form.control} name="ifWrong" label={copy.form.ifWrong} placeholder={copy.form.ifWrongPlaceholder} rows={2} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField control={form.control} name="ownerId" label={copy.form.owner} noneLabel={copy.form.noOwner} options={members} />
        <SelectField
          control={form.control}
          name="confidence"
          label={copy.form.confidence}
          options={ASSUMPTION_CONFIDENCES.map((level) => ({ value: level, label: copy.confidence[level] }))}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField control={form.control} name="dueDate" label={copy.form.dueDate.assumption} />
        {edit ? <StatusField control={form.control} kind="assumption" /> : null}
      </div>
    </FormShell>
  );
}

// ── Issue ───────────────────────────────────────────────────────────────────

function IssueForm({ edit, onClose }: Readonly<{ edit: RaidItem | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const members = useMemberOptions();
  const resolverOptions = useResolverOptions();
  const ownerDefault = useDefaultOwner();
  const { save, pending, submitLabel } = useItemSave('issue', edit, onClose);

  const form = useForm<IssueFormValues>({
    resolver: zodResolver(issueFormSchema, resolverOptions),
    defaultValues: edit ? issueValuesFromItem(edit) : defaultIssueValues(ownerDefault),
  });

  return (
    <FormShell form={form} onSubmit={save} pending={pending} submitLabel={submitLabel}>
      <TextField control={form.control} name="title" label={copy.form.title} placeholder={copy.form.titlePlaceholder.issue} autoFocus />
      <TextAreaField control={form.control} name="description" label={copy.form.description.issue} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField control={form.control} name="ownerId" label={copy.form.owner} noneLabel={copy.form.noOwner} options={members} />
        <SelectField
          control={form.control}
          name="severity"
          label={copy.form.severity}
          options={ISSUE_SEVERITIES.map((level) => ({ value: level, label: copy.severity[level] }))}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField control={form.control} name="dueDate" label={copy.form.dueDate.issue} />
        {edit ? <StatusField control={form.control} kind="issue" /> : null}
      </div>
      <CheckboxField control={form.control} name="escalated" label={copy.form.escalated} />
    </FormShell>
  );
}

// ── Dependency ──────────────────────────────────────────────────────────────

function DependencyForm({ edit, onClose }: Readonly<{ edit: RaidItem | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { projectId } = useRaid();
  const members = useMemberOptions();
  const resolverOptions = useResolverOptions();
  const ownerDefault = useDefaultOwner();
  const { save, pending, submitLabel } = useItemSave('dependency', edit, onClose);
  const projects = useProjects({ pageSize: 100 });

  const form = useForm<DependencyFormValues>({
    resolver: zodResolver(dependencyFormSchema, resolverOptions),
    defaultValues: edit ? dependencyValuesFromItem(edit) : defaultDependencyValues(ownerDefault),
  });
  const partyType = form.watch('partyType');
  const projectOptions = (projects.data?.data ?? [])
    .filter((project) => project.id !== projectId)
    .map((project) => ({ value: project.id, label: project.name }));

  return (
    <FormShell form={form} onSubmit={save} pending={pending} submitLabel={submitLabel}>
      <TextField control={form.control} name="title" label={copy.form.title} placeholder={copy.form.titlePlaceholder.dependency} autoFocus />
      <TextAreaField control={form.control} name="description" label={copy.form.description.dependency} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={form.control}
          name="direction"
          label={copy.form.direction}
          options={DEPENDENCY_DIRECTIONS.map((direction) => ({ value: direction, label: copy.direction[direction] }))}
        />
        <SelectField control={form.control} name="ownerId" label={copy.form.owner} noneLabel={copy.form.noOwner} options={members} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={form.control}
          name="partyType"
          label={copy.form.partyType}
          noneLabel={copy.form.noPartyType}
          options={DEPENDENCY_PARTY_TYPES.map((type) => ({ value: type, label: copy.partyType[type] }))}
        />
        {partyType === 'project' ? (
          <SelectField
            control={form.control}
            name="partyProjectId"
            label={copy.form.partyProject}
            placeholder={copy.form.partyProjectPlaceholder}
            options={projectOptions}
          />
        ) : (
          <TextField control={form.control} name="partyName" label={copy.form.partyName} placeholder={copy.form.partyNamePlaceholder} />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField control={form.control} name="dueDate" label={copy.form.dueDate.dependency} />
        {edit ? <StatusField control={form.control} kind="dependency" /> : null}
      </div>
    </FormShell>
  );
}
