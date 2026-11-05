/**
 * The dialogs of the benefits register: create and edit a benefit with its
 * measure, and add a measurement by hand.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { Form } from '@weldsuite/ui/components/form';
import { BENEFIT_METRICS } from '@weldsuite/app-api-client/schemas/project-governance';
import {
  type Benefit,
  type BenefitMetric,
  type CreateBenefitInput,
} from '@weldsuite/app-api-client/domains/project-governance';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateBenefit, useCreateMeasurement, useUpdateBenefit } from '@/hooks/queries/use-project-governance-queries';
import { SelectField, TextAreaField, TextField, type SelectOption } from '../../../raid/_components/form-fields';
import { fromDateInput, toDateInput } from '../../../governance/_lib/use-governance';
import { FormDialog } from '../../../governance/_components/parts';

const NONE = '__none__';

export type BenefitDialogState = { kind: 'create' } | { kind: 'edit'; benefit: Benefit } | { kind: 'measure'; benefit: Benefit };

export function BenefitDialogs({
  projectId,
  state,
  memberOptions,
  goalOptions,
  onClose,
  onSaved,
}: Readonly<{
  projectId: string;
  state: BenefitDialogState | null;
  memberOptions: SelectOption[];
  goalOptions: SelectOption[];
  onClose: () => void;
  onSaved: (id: string) => void;
}>) {
  if (!state) return null;
  if (state.kind === 'measure') return <MeasurementDialog benefit={state.benefit} onClose={onClose} onSaved={onSaved} />;
  return (
    <BenefitForm
      projectId={projectId}
      edit={state.kind === 'edit' ? state.benefit : null}
      memberOptions={memberOptions}
      goalOptions={goalOptions}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

interface FormValues {
  title: string;
  description: string;
  ownerId: string;
  metric: BenefitMetric;
  tag: string;
  supplierId: string;
  sources: string;
  unit: string;
  baselineValue: string;
  targetValue: string;
  realiseBy: string;
  goalRef: string;
  status: string;
}

/** A number typed in a text input: empty is null, anything else has to be a number. */
const numberText = (message: string) =>
  z.string().refine((value) => value.trim() === '' || Number.isFinite(Number(value.replace(',', '.'))), { message });
const toNumber = (value: string): number | null => (value.trim() === '' ? null : Number(value.replace(',', '.')));

function paramsOf(values: FormValues): Record<string, unknown> {
  switch (values.metric) {
    case 'desk_tickets_by_tag':
    case 'time_hours_per_week_by_tag':
      return { tag: values.tag.trim() };
    case 'books_supplier_cost':
      return { supplierId: values.supplierId.trim() };
    case 'commerce_repeat_online_share': {
      const sources = values.sources.split(',').map((s) => s.trim()).filter(Boolean);
      return sources.length > 0 ? { sources } : {};
    }
    default:
      return {};
  }
}

function BenefitForm({
  projectId,
  edit,
  memberOptions,
  goalOptions,
  onClose,
  onSaved,
}: Readonly<{
  projectId: string;
  edit: Benefit | null;
  memberOptions: SelectOption[];
  goalOptions: SelectOption[];
  onClose: () => void;
  onSaved: (id: string) => void;
}>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.value;
  const f = copy.form;
  const create = useCreateBenefit();
  const update = useUpdateBenefit();

  const schema = z.object({
    title: z.string().trim().min(1, t.flowGovernance.common.required).max(255),
    description: z.string().max(10_000),
    ownerId: z.string(),
    metric: z.enum(BENEFIT_METRICS),
    tag: z.string().max(100),
    supplierId: z.string().max(255),
    sources: z.string(),
    unit: z.string().max(30),
    baselineValue: numberText(f.invalidNumber),
    targetValue: numberText(f.invalidNumber),
    realiseBy: z.string(),
    goalRef: z.string(),
    status: z.string(),
  });

  const params = (edit?.metricParams ?? {}) as { tag?: string; supplierId?: string; sources?: string[] };
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: edit?.title ?? '',
      description: edit?.description ?? '',
      ownerId: edit?.ownerId ?? NONE,
      metric: (edit?.metric as BenefitMetric | undefined) ?? 'manual',
      tag: params.tag ?? '',
      supplierId: params.supplierId ?? '',
      sources: (params.sources ?? []).join(', '),
      unit: edit?.unit ?? '',
      baselineValue: edit?.baselineValue ? String(Number(edit.baselineValue)) : '',
      targetValue: edit?.targetValue ? String(Number(edit.targetValue)) : '',
      realiseBy: toDateInput(edit?.realiseBy),
      goalRef: edit?.goalRef ?? NONE,
      status: edit?.status ?? 'planned',
    },
  });
  const metric = form.watch('metric');

  const submit = form.handleSubmit(async (values) => {
    // A metric that needs a parameter says so before the request does.
    if ((values.metric === 'desk_tickets_by_tag' || values.metric === 'time_hours_per_week_by_tag') && !values.tag.trim()) {
      form.setError('tag', { message: t.flowGovernance.common.required });
      return;
    }
    if (values.metric === 'books_supplier_cost' && !values.supplierId.trim()) {
      form.setError('supplierId', { message: t.flowGovernance.common.required });
      return;
    }
    const common = {
      title: values.title.trim(),
      description: values.description.trim() || null,
      ownerId: values.ownerId === NONE ? null : values.ownerId,
      goalRef: values.goalRef === NONE ? null : values.goalRef,
      metric: values.metric,
      metricParams: paramsOf(values),
      unit: values.unit.trim() || null,
      baselineValue: toNumber(values.baselineValue),
      targetValue: toNumber(values.targetValue),
      realiseBy: fromDateInput(values.realiseBy),
    };
    try {
      if (edit) {
        const res = await update.mutateAsync({ id: edit.id, data: { ...common, status: values.status as Benefit['status'] } });
        toast.success(copy.toasts.updated);
        onSaved(res.data.id);
      } else {
        const input: CreateBenefitInput = { projectId, ...common, status: values.status === 'measuring' ? 'measuring' : 'planned' };
        const res = await create.mutateAsync(input);
        toast.success(copy.toasts.created);
        onSaved(res.data.id);
      }
    } catch {
      toast.error(t.flowGovernance.common.saveFailed);
    }
  });

  const statusOptions = (edit ? (['planned', 'measuring', 'at_risk', 'realised', 'closed'] as const) : (['planned', 'measuring'] as const)).map((value) => ({
    value,
    label: copy.statuses[value],
  }));

  return (
    <FormDialog
      open
      wide
      onClose={onClose}
      title={edit ? f.editTitle : f.createTitle}
      description={f.description}
      submitLabel={edit ? f.submitEdit : f.submitCreate}
      pending={create.isPending || update.isPending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        <TextField control={form.control} name="title" label={f.title} placeholder={f.titlePlaceholder} autoFocus />
        <TextAreaField control={form.control} name="description" label={f.descriptionLabel} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField control={form.control} name="ownerId" label={f.owner} options={[{ value: NONE, label: t.flowGovernance.common.unassigned }, ...memberOptions]} />
          <SelectField control={form.control} name="status" label={f.status} options={statusOptions} />
        </div>
        <SelectField
          control={form.control}
          name="metric"
          label={f.metric}
          options={BENEFIT_METRICS.map((value) => ({ value, label: `${copy.metrics[value]} (${copy.sources[value]})` }))}
        />
        {metric === 'desk_tickets_by_tag' || metric === 'time_hours_per_week_by_tag' ? (
          <TextField control={form.control} name="tag" label={copy.params.tag} />
        ) : null}
        {metric === 'books_supplier_cost' ? <TextField control={form.control} name="supplierId" label={copy.params.supplierId} /> : null}
        {metric === 'commerce_repeat_online_share' ? (
          <TextField control={form.control} name="sources" label={copy.params.sources} description={copy.params.sourcesHelp} />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField control={form.control} name="unit" label={f.unit} placeholder={f.unitPlaceholder} />
          <TextField control={form.control} name="baselineValue" label={f.baseline} />
          <TextField control={form.control} name="targetValue" label={f.target} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField control={form.control} name="realiseBy" label={f.realiseBy} type="date" />
          <SelectField control={form.control} name="goalRef" label={f.goal} options={[{ value: NONE, label: f.goalNone }, ...goalOptions]} />
        </div>
      </Form>
    </FormDialog>
  );
}

function MeasurementDialog({ benefit, onClose, onSaved }: Readonly<{ benefit: Benefit; onClose: () => void; onSaved: (id: string) => void }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.value;
  const m = copy.measurement;
  const save = useCreateMeasurement();
  const thisMonth = new Date().toISOString().slice(0, 7);

  const schema = z.object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, t.flowGovernance.common.required).refine((p) => p <= thisMonth, { message: m.future }),
    value: z.string().refine((v) => v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))), { message: copy.form.invalidNumber }),
  });
  const form = useForm<{ period: string; value: string }>({ resolver: zodResolver(schema), defaultValues: { period: thisMonth, value: '' } });

  const submit = form.handleSubmit(async (values) => {
    try {
      await save.mutateAsync({ id: benefit.id, data: { period: values.period, value: Number(values.value.replace(',', '.')) } });
      toast.success(copy.toasts.measured);
      onSaved(benefit.id);
    } catch {
      toast.error(t.flowGovernance.common.saveFailed);
    }
  });

  return (
    <FormDialog open onClose={onClose} title={m.title} description={m.description} submitLabel={m.submit} pending={save.isPending} onSubmit={() => void submit()}>
      <Form {...form}>
        <TextField control={form.control} name="period" label={m.period} placeholder="2026-10" />
        <TextField control={form.control} name="value" label={m.value} autoFocus />
      </Form>
    </FormDialog>
  );
}
