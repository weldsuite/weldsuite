/**
 * The dialogs of the decision log: create and edit a decision, record it, and
 * replace it with a newer one. React Hook Form with a Zod resolver.
 */

import { useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Form } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import type {
  CreateDecisionInput,
  Decision,
  DecisionDetail,
  UpdateDecisionInput,
} from '@weldsuite/app-api-client/domains/project-governance';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateDecision,
  useDecideDecision,
  useSupersedeDecision,
  useUpdateDecision,
} from '@/hooks/queries/use-project-governance-queries';
import { SelectField, TextAreaField, TextField, type SelectOption } from '../../../raid/_components/form-fields';
import { fromDateInput, toDateInput } from '../../_lib/use-governance';
import { FormDialog } from '../../_components/parts';

const NONE = '__none__';

export type DecisionDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; decision: DecisionDetail }
  | { kind: 'decide'; decision: Decision }
  | { kind: 'supersede'; decision: Decision };

interface DialogProps {
  projectId: string;
  memberOptions: SelectOption[];
  decisions: Decision[];
  state: DecisionDialogState | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

export function DecisionDialogs(props: Readonly<DialogProps>) {
  const { state } = props;
  if (!state) return null;
  if (state.kind === 'decide') return <DecideDialog {...props} decision={state.decision} />;
  if (state.kind === 'supersede') return <SupersedeDialog {...props} decision={state.decision} />;
  return <DecisionForm {...props} edit={state.kind === 'edit' ? state.decision : null} />;
}

// ── Create and edit ─────────────────────────────────────────────────────────

interface FormValues {
  title: string;
  context: string;
  mode: 'proposed' | 'decided';
  options: Array<{ title: string; note: string }>;
  chosen: string;
  consequences: Array<{ text: string }>;
  deciderId: string;
  decisionDueAt: string;
  decidedBy: string;
  decidedAt: string;
}

function valuesOf(edit: DecisionDetail | null, userId: string | null): FormValues {
  if (!edit) {
    return {
      title: '',
      context: '',
      mode: 'proposed',
      options: [{ title: '', note: '' }],
      chosen: NONE,
      consequences: [],
      deciderId: NONE,
      decisionDueAt: '',
      decidedBy: userId ?? NONE,
      decidedAt: toDateInput(new Date().toISOString()),
    };
  }
  const chosen = edit.options.findIndex((option) => option.chosen);
  return {
    title: edit.title,
    context: edit.context ?? '',
    mode: edit.status === 'proposed' ? 'proposed' : 'decided',
    options: edit.options.map((option) => ({ title: option.title, note: option.note ?? '' })),
    chosen: chosen >= 0 ? String(chosen) : NONE,
    consequences: edit.consequences.map((text) => ({ text })),
    deciderId: edit.deciderId ?? NONE,
    decisionDueAt: toDateInput(edit.decisionDueAt),
    decidedBy: edit.decidedBy ?? NONE,
    decidedAt: toDateInput(edit.decidedAt),
  };
}

function DecisionForm({
  projectId,
  memberOptions,
  edit,
  onClose,
  onSaved,
}: Readonly<DialogProps & { edit: DecisionDetail | null }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  const { userId } = useAuth();
  const create = useCreateDecision();
  const update = useUpdateDecision();
  const locked = !!edit && edit.status !== 'proposed';

  const schema = useMemo(
    () =>
      z.object({
        title: z.string().trim().min(1, t.flowGovernance.common.required).max(255),
        context: z.string().max(10_000),
        mode: z.enum(['proposed', 'decided']),
        options: z.array(z.object({ title: z.string().max(255), note: z.string().max(2_000) })),
        chosen: z.string(),
        consequences: z.array(z.object({ text: z.string().max(1_000) })),
        deciderId: z.string(),
        decisionDueAt: z.string(),
        decidedBy: z.string(),
        decidedAt: z.string(),
      }),
    [t],
  );
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: valuesOf(edit, userId ?? null) });
  const options = useFieldArray({ control: form.control, name: 'options' });
  const consequences = useFieldArray({ control: form.control, name: 'consequences' });
  const mode = form.watch('mode');
  const optionValues = form.watch('options');
  const pending = create.isPending || update.isPending;

  const chosenOptions: SelectOption[] = optionValues
    .map((option, index) => ({ value: String(index), label: option.title.trim() }))
    .filter((option) => option.label.length > 0);

  const submit = form.handleSubmit(async (values) => {
    // Empty rows are dropped; the chosen index follows the options that stay.
    const kept = values.options.map((option, index) => ({ ...option, index })).filter((option) => option.title.trim().length > 0);
    const body = {
      options: kept.map((option) => ({
        title: option.title.trim(),
        note: option.note.trim() || null,
        chosen: values.chosen !== NONE && Number(values.chosen) === option.index,
      })),
      consequences: values.consequences.map((c) => c.text.trim()).filter(Boolean),
    };
    try {
      if (edit) {
        const data: UpdateDecisionInput = {
          title: values.title.trim(),
          context: values.context.trim() || null,
          consequences: body.consequences,
          ...(locked
            ? {}
            : {
                options: body.options,
                deciderId: values.deciderId === NONE ? null : values.deciderId,
                decisionDueAt: fromDateInput(values.decisionDueAt),
              }),
        };
        await update.mutateAsync({ id: edit.id, data });
        toast.success(copy.toasts.updated);
        onSaved(edit.id);
        return;
      }
      const decided = values.mode === 'decided';
      const input: CreateDecisionInput = {
        projectId,
        title: values.title.trim(),
        context: values.context.trim() || null,
        ...body,
        status: values.mode,
        ...(decided
          ? {
              decidedBy: values.decidedBy === NONE ? null : values.decidedBy,
              decidedAt: fromDateInput(values.decidedAt),
            }
          : {
              deciderId: values.deciderId === NONE ? null : values.deciderId,
              decisionDueAt: fromDateInput(values.decisionDueAt),
            }),
      };
      const res = await create.mutateAsync(input);
      toast.success(copy.toasts.created);
      onSaved(res.data.id);
    } catch {
      toast.error(t.flowGovernance.common.saveFailed);
    }
  });

  const f = copy.form;
  return (
    <FormDialog
      open
      wide
      onClose={onClose}
      title={edit ? f.editTitle : f.createTitle}
      description={f.description}
      submitLabel={edit ? f.submitEdit : f.submitCreate}
      pending={pending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        <TextField control={form.control} name="title" label={f.title} placeholder={f.titlePlaceholder} autoFocus />
        <TextAreaField control={form.control} name="context" label={f.context} placeholder={f.contextPlaceholder} />

        {edit ? null : (
          <SelectField
            control={form.control}
            name="mode"
            label={f.mode}
            options={[
              { value: 'proposed', label: f.modeProposed },
              { value: 'decided', label: f.modeDecided },
            ]}
          />
        )}

        {locked ? <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{f.lockedHint}</p> : null}

        {locked ? null : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{f.options}</legend>
            {options.fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <Input aria-label={`${f.optionTitle} ${index + 1}`} placeholder={f.optionTitle} {...form.register(`options.${index}.title`)} />
                  <Input aria-label={`${f.optionNote} ${index + 1}`} placeholder={f.optionNote} {...form.register(`options.${index}.note`)} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={f.removeOption} onClick={() => options.remove(index)}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => options.append({ title: '', note: '' })}>
              <Plus aria-hidden />
              {f.addOption}
            </Button>
          </fieldset>
        )}

        {locked || chosenOptions.length === 0 || (!edit && mode === 'proposed') ? null : (
          <SelectField
            control={form.control}
            name="chosen"
            label={f.chosenOption}
            options={[{ value: NONE, label: f.noneChosen }, ...chosenOptions]}
          />
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{f.consequences}</legend>
          {consequences.fields.map((field, index) => (
            <div key={field.id} className="flex items-center gap-2">
              <Input aria-label={`${f.consequences} ${index + 1}`} placeholder={f.consequencePlaceholder} {...form.register(`consequences.${index}.text`)} />
              <Button type="button" variant="ghost" size="icon" aria-label={f.removeConsequence} onClick={() => consequences.remove(index)}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => consequences.append({ text: '' })}>
            <Plus aria-hidden />
            {f.addConsequence}
          </Button>
        </fieldset>

        {locked ? null : mode === 'proposed' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              control={form.control}
              name="deciderId"
              label={f.decider}
              description={f.deciderHelp}
              options={[{ value: NONE, label: t.flowGovernance.common.none }, ...memberOptions]}
            />
            <TextField control={form.control} name="decisionDueAt" label={f.dueDate} type="date" />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              control={form.control}
              name="decidedBy"
              label={f.decidedBy}
              options={[{ value: NONE, label: t.flowGovernance.common.none }, ...memberOptions]}
            />
            <TextField control={form.control} name="decidedAt" label={f.decidedAt} type="date" />
          </div>
        )}
      </Form>
    </FormDialog>
  );
}

// ── Decide ──────────────────────────────────────────────────────────────────

function DecideDialog({
  decision,
  memberOptions,
  onClose,
  onSaved,
}: Readonly<DialogProps & { decision: Decision }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  const { userId } = useAuth();
  const decide = useDecideDecision();
  const marked = decision.options.findIndex((option) => option.chosen);
  const needsChoice = decision.options.length > 0;

  const form = useForm<{ chosen: string; decidedBy: string; decidedAt: string }>({
    defaultValues: {
      chosen: marked >= 0 ? String(marked) : NONE,
      decidedBy: decision.deciderId ?? userId ?? NONE,
      decidedAt: toDateInput(new Date().toISOString()),
    },
  });

  const submit = form.handleSubmit(async (values) => {
    if (needsChoice && values.chosen === NONE) {
      form.setError('chosen', { message: t.flowGovernance.common.required });
      return;
    }
    try {
      await decide.mutateAsync({
        id: decision.id,
        data: {
          ...(values.chosen === NONE ? {} : { chosenIndex: Number(values.chosen) }),
          ...(values.decidedBy === NONE ? {} : { decidedBy: values.decidedBy }),
          ...(values.decidedAt ? { decidedAt: fromDateInput(values.decidedAt) ?? undefined } : {}),
        },
      });
      toast.success(copy.toasts.decided);
      onSaved(decision.id);
    } catch {
      toast.error(t.flowGovernance.common.actionFailed);
    }
  });

  return (
    <FormDialog
      open
      onClose={onClose}
      title={copy.decide.title}
      description={copy.decide.description}
      submitLabel={copy.decide.submit}
      pending={decide.isPending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        {needsChoice ? (
          <SelectField
            control={form.control}
            name="chosen"
            label={copy.decide.option}
            options={[
              { value: NONE, label: copy.form.noneChosen },
              ...decision.options.map((option, index) => ({ value: String(index), label: option.title })),
            ]}
          />
        ) : null}
        <SelectField
          control={form.control}
          name="decidedBy"
          label={copy.decide.decidedBy}
          options={[{ value: NONE, label: t.flowGovernance.common.none }, ...memberOptions]}
        />
        <TextField control={form.control} name="decidedAt" label={copy.decide.decidedAt} type="date" />
      </Form>
    </FormDialog>
  );
}

// ── Supersede ───────────────────────────────────────────────────────────────

function SupersedeDialog({
  decision,
  decisions,
  onClose,
  onSaved,
}: Readonly<DialogProps & { decision: Decision }>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const supersede = useSupersedeDecision();
  const candidates = decisions.filter((other) => other.id !== decision.id && other.status !== 'superseded');
  const form = useForm<{ by: string }>({ defaultValues: { by: NONE } });

  const submit = form.handleSubmit(async (values) => {
    if (values.by === NONE) {
      form.setError('by', { message: t.flowGovernance.common.required });
      return;
    }
    try {
      await supersede.mutateAsync({ id: decision.id, data: { supersededById: values.by } });
      toast.success(copy.toasts.superseded);
      onSaved(decision.id);
    } catch {
      toast.error(t.flowGovernance.common.actionFailed);
    }
  });

  return (
    <FormDialog
      open
      onClose={onClose}
      title={format(copy.supersede.title, { code: decision.code })}
      description={candidates.length === 0 ? copy.supersede.noCandidates : copy.supersede.description}
      submitLabel={copy.supersede.submit}
      pending={supersede.isPending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        <SelectField
          control={form.control}
          name="by"
          label={copy.supersede.by}
          options={[
            { value: NONE, label: copy.supersede.none },
            ...candidates.map((other) => ({ value: other.id, label: `${other.code} · ${other.title}` })),
          ]}
        />
      </Form>
    </FormDialog>
  );
}
