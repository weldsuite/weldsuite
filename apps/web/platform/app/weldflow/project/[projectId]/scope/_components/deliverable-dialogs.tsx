/**
 * The dialogs of a deliverable: create and edit it with its acceptance
 * criteria, and its detail with the sign-off (ask for it, accept, reject).
 */

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import type { Deliverable } from '@weldsuite/app-api-client/domains/project-governance';
import { useI18n } from '@/lib/i18n/provider';
import {
  useAcceptDeliverable,
  useCreateDeliverable,
  useDeleteDeliverable,
  useDeliverable,
  useRejectDeliverable,
  useRequestSignoff,
  useUpdateDeliverable,
} from '@/hooks/queries/use-project-governance-queries';
import { CheckboxField, SelectField, TextAreaField, TextField, type SelectOption } from '../../raid/_components/form-fields';
import { fromDateInput, toDateInput, useFormatters, type GovernanceAbilities } from '../../governance/_lib/use-governance';
import { ConfirmDelete, FormDialog, Pill } from '../../governance/_components/parts';

const NONE = '__none__';

export type DeliverableDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; deliverable: Deliverable }
  | { kind: 'detail'; deliverable: Deliverable };

export function DeliverableDialogs({
  projectId,
  state,
  memberOptions,
  abilities,
  memberName,
  onState,
}: Readonly<{
  projectId: string;
  state: DeliverableDialogState | null;
  memberOptions: SelectOption[];
  abilities: GovernanceAbilities;
  memberName: (id: string | null) => string;
  onState: (state: DeliverableDialogState | null) => void;
}>) {
  if (!state) return null;
  if (state.kind === 'detail') {
    return (
      <DetailDialog
        id={state.deliverable.id}
        abilities={abilities}
        memberName={memberName}
        onClose={() => onState(null)}
        onEdit={(deliverable) => onState({ kind: 'edit', deliverable })}
      />
    );
  }
  return (
    <DeliverableForm
      projectId={projectId}
      edit={state.kind === 'edit' ? state.deliverable : null}
      memberOptions={memberOptions}
      onClose={() => onState(null)}
    />
  );
}

// ── Form ────────────────────────────────────────────────────────────────────

interface FormValues {
  title: string;
  description: string;
  ownerId: string;
  status: 'not_started' | 'in_progress';
  plannedStart: string;
  plannedEnd: string;
  clientVisible: boolean;
  criteria: Array<{ text: string; met: boolean }>;
}

function DeliverableForm({
  projectId,
  edit,
  memberOptions,
  onClose,
}: Readonly<{ projectId: string; edit: Deliverable | null; memberOptions: SelectOption[]; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.scope;
  const f = copy.deliverableForm;
  const create = useCreateDeliverable();
  const update = useUpdateDeliverable();
  const locked = edit?.status === 'accepted';

  const schema = z
    .object({
      title: z.string().trim().min(1, t.flowGovernance.common.required).max(255),
      description: z.string().max(10_000),
      ownerId: z.string(),
      status: z.enum(['not_started', 'in_progress']),
      plannedStart: z.string(),
      plannedEnd: z.string(),
      clientVisible: z.boolean(),
      criteria: z.array(z.object({ text: z.string().max(1_000), met: z.boolean() })),
    })
    .refine((v) => !v.plannedStart || !v.plannedEnd || v.plannedEnd >= v.plannedStart, { message: f.datesOrder, path: ['plannedEnd'] });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: edit?.title ?? '',
      description: edit?.description ?? '',
      ownerId: edit?.ownerId ?? NONE,
      status: edit?.status === 'in_progress' ? 'in_progress' : 'not_started',
      plannedStart: toDateInput(edit?.plannedStart),
      plannedEnd: toDateInput(edit?.plannedEnd),
      clientVisible: edit?.clientVisible ?? false,
      criteria: (edit?.acceptanceCriteria ?? []).map((c) => ({ text: c.text, met: c.met })),
    },
  });
  const criteria = useFieldArray({ control: form.control, name: 'criteria' });

  const submit = form.handleSubmit(async (values) => {
    try {
      if (edit && locked) {
        await update.mutateAsync({ id: edit.id, data: { clientVisible: values.clientVisible } });
      } else if (edit) {
        await update.mutateAsync({
          id: edit.id,
          data: {
            title: values.title.trim(),
            description: values.description.trim() || null,
            ownerId: values.ownerId === NONE ? null : values.ownerId,
            status: values.status,
            plannedStart: fromDateInput(values.plannedStart),
            plannedEnd: fromDateInput(values.plannedEnd),
            clientVisible: values.clientVisible,
            acceptanceCriteria: values.criteria.filter((c) => c.text.trim()).map((c) => ({ text: c.text.trim(), met: c.met })),
          },
        });
      } else {
        await create.mutateAsync({
          projectId,
          title: values.title.trim(),
          description: values.description.trim() || null,
          ownerId: values.ownerId === NONE ? null : values.ownerId,
          status: values.status,
          plannedStart: fromDateInput(values.plannedStart),
          plannedEnd: fromDateInput(values.plannedEnd),
          clientVisible: values.clientVisible,
          acceptanceCriteria: values.criteria.filter((c) => c.text.trim()).map((c) => ({ text: c.text.trim(), met: c.met })),
        });
      }
      toast.success(edit ? copy.toasts.updated : copy.toasts.created);
      onClose();
    } catch {
      toast.error(t.flowGovernance.common.saveFailed);
    }
  });

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
        {locked ? <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{f.lockedHint}</p> : null}
        {locked ? null : (
          <>
            <TextField control={form.control} name="title" label={f.title} placeholder={f.titlePlaceholder} autoFocus />
            <TextAreaField control={form.control} name="description" label={f.description_} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                control={form.control}
                name="ownerId"
                label={f.owner}
                options={[{ value: NONE, label: t.flowGovernance.common.unassigned }, ...memberOptions]}
              />
              <SelectField
                control={form.control}
                name="status"
                label={f.statusLabel}
                options={[
                  { value: 'not_started', label: copy.deliverables.statuses.not_started },
                  { value: 'in_progress', label: copy.deliverables.statuses.in_progress },
                ]}
              />
              <TextField control={form.control} name="plannedStart" label={f.plannedStart} type="date" />
              <TextField control={form.control} name="plannedEnd" label={f.plannedEnd} type="date" />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{f.criteria}</legend>
              {criteria.fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <Checkbox
                    aria-label={f.met}
                    checked={form.watch(`criteria.${index}.met`)}
                    onCheckedChange={(checked) => form.setValue(`criteria.${index}.met`, checked === true)}
                  />
                  <Input aria-label={`${f.criteria} ${index + 1}`} placeholder={f.criterionPlaceholder} {...form.register(`criteria.${index}.text`)} />
                  <Button type="button" variant="ghost" size="icon" aria-label={f.removeCriterion} onClick={() => criteria.remove(index)}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => criteria.append({ text: '', met: false })}>
                <Plus aria-hidden />
                {f.addCriterion}
              </Button>
            </fieldset>
          </>
        )}
        <CheckboxField control={form.control} name="clientVisible" label={f.clientVisible} />
      </Form>
    </FormDialog>
  );
}

// ── Detail and sign-off ─────────────────────────────────────────────────────

const ANSWER_TONE = { pending: 'neutral', approved: 'success', approved_with_conditions: 'success', rejected: 'danger', info_requested: 'warning' } as const;

function DetailDialog({
  id,
  abilities,
  memberName,
  onClose,
  onEdit,
}: Readonly<{
  id: string;
  abilities: GovernanceAbilities;
  memberName: (id: string | null) => string;
  onClose: () => void;
  onEdit: (deliverable: Deliverable) => void;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.scope;
  const d = copy.deliverableDetail;
  const formatters = useFormatters();
  const query = useDeliverable(id);
  const accept = useAcceptDeliverable();
  const remove = useDeleteDeliverable();
  const [panel, setPanel] = useState<'request' | 'reject' | 'delete' | null>(null);
  const row = query.data;

  const act = async (run: () => Promise<unknown>, success: string) => {
    try {
      await run();
      toast.success(success);
      setPanel(null);
    } catch {
      toast.error(t.flowGovernance.common.actionFailed);
    }
  };

  const criteriaOpen = !!row && row.criteriaMet < row.criteriaTotal;
  const waiting = !!row && row.signoff.some((s) => s.decision === 'pending' || s.decision === 'info_requested');

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{row ? format(d.title, { code: row.code, name: row.title }) : copy.deliverables.title}</DialogTitle>
            <DialogDescription>{row ? copy.deliverables.statuses[row.status] : ''}</DialogDescription>
          </DialogHeader>
          {row ? (
            <div className="flex flex-col gap-4 text-sm">
              {row.description ? <p className="whitespace-pre-line">{row.description}</p> : null}
              <section>
                <h3 className="mb-1.5 text-[13px] font-semibold text-foreground/80">{copy.deliverableForm.criteria}</h3>
                {row.acceptanceCriteria.length === 0 ? (
                  <p className="text-muted-foreground">{copy.deliverables.noCriteria}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {row.acceptanceCriteria.map((c, index) => (
                      <li key={index} className="flex items-start gap-2">
                        <span aria-hidden className={c.met ? 'text-green-700' : 'text-muted-foreground'}>{c.met ? '✓' : '○'}</span>
                        <span className={c.met ? '' : 'text-foreground/80'}>{c.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="mb-1.5 text-[13px] font-semibold text-foreground/80">{d.signoff}</h3>
                {row.signoff.length === 0 ? (
                  <p className="text-muted-foreground">{d.noSignoff}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {row.signoff.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">{s.step === 1 ? d.steps.sponsor : d.steps.client}</span>
                        <span>{s.approverKind === 'member' ? memberName(s.approverId) : s.approverId}</span>
                        <Pill tone={ANSWER_TONE[s.decision as keyof typeof ANSWER_TONE] ?? 'neutral'}>
                          {d.answers[s.decision as keyof typeof d.answers] ?? s.decision}
                        </Pill>
                        {s.note ? <span className="text-xs text-muted-foreground">{s.note}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {row.status === 'accepted' && row.acceptedAt ? (
                  <p className="mt-2 text-xs text-muted-foreground">{format(copy.deliverables.acceptedOn, { date: formatters.date(row.acceptedAt) })}</p>
                ) : null}
              </section>
              <section>
                <h3 className="mb-1.5 text-[13px] font-semibold text-foreground/80">{d.links}</h3>
                {row.links.length === 0 ? (
                  <p className="text-muted-foreground">{t.flowGovernance.common.noLinks}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {row.links.map((link) => (
                      <span key={link.id} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs">
                        <span className="text-muted-foreground">{t.flowGovernance.common.linkKinds[link.target.type]}</span>
                        <span className="font-semibold">{link.target.code ?? link.target.title}</span>
                      </span>
                    ))}
                  </div>
                )}
              </section>
              {abilities.manage && row.status !== 'accepted' && criteriaOpen ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{d.criteriaOpen}</p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
                {abilities.remove ? (
                  <Button type="button" variant="ghost" onClick={() => setPanel('delete')}>
                    {t.flowGovernance.common.delete}
                  </Button>
                ) : null}
                {abilities.update ? (
                  <Button type="button" variant="outline" onClick={() => onEdit(row)}>
                    {t.flowGovernance.common.edit}
                  </Button>
                ) : null}
                {abilities.manage && row.status !== 'accepted' ? (
                  <>
                    <Button type="button" variant="outline" onClick={() => setPanel('reject')}>
                      {d.reject}
                    </Button>
                    <Button type="button" variant="outline" disabled={criteriaOpen || waiting} onClick={() => setPanel('request')}>
                      {d.requestSignoff}
                    </Button>
                    <Button
                      type="button"
                      disabled={criteriaOpen || accept.isPending}
                      onClick={() => void act(() => accept.mutateAsync(row.id), d.toasts.accepted)}
                    >
                      {d.accept}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {row && panel === 'request' ? <RequestSignoffDialog id={row.id} onDone={() => setPanel(null)} /> : null}
      {row && panel === 'reject' ? <RejectDialog deliverable={row} onDone={() => setPanel(null)} /> : null}
      {row ? (
        <ConfirmDelete
          open={panel === 'delete'}
          code={row.code}
          pending={remove.isPending}
          onCancel={() => setPanel(null)}
          onConfirm={() =>
            void (async () => {
              try {
                await remove.mutateAsync(row.id);
                toast.success(copy.toasts.deleted);
                onClose();
              } catch {
                toast.error(t.flowGovernance.common.deleteFailed);
              }
            })()
          }
        />
      ) : null}
    </>
  );
}

function RequestSignoffDialog({ id, onDone }: Readonly<{ id: string; onDone: () => void }>) {
  const { t } = useI18n();
  const d = t.flowGovernance.scope.deliverableDetail;
  const request = useRequestSignoff();
  const form = useForm<{ contactId: string; dueAt: string }>({ defaultValues: { contactId: '', dueAt: '' } });
  const submit = form.handleSubmit(async (values) => {
    try {
      await request.mutateAsync({
        id,
        data: {
          ...(values.contactId.trim() ? { contactId: values.contactId.trim() } : {}),
          ...(values.dueAt ? { dueAt: fromDateInput(values.dueAt) ?? undefined } : {}),
        },
      });
      toast.success(d.toasts.requested);
      onDone();
    } catch {
      toast.error(t.flowGovernance.common.actionFailed);
    }
  });
  return (
    <FormDialog open onClose={onDone} title={d.requestTitle} description={d.requestDescription} submitLabel={d.submitRequest} pending={request.isPending} onSubmit={() => void submit()}>
      <Form {...form}>
        <TextField control={form.control} name="contactId" label={d.contactId} description={d.contactHelp} />
        <TextField control={form.control} name="dueAt" label={d.dueAt} type="date" />
      </Form>
    </FormDialog>
  );
}

function RejectDialog({ deliverable, onDone }: Readonly<{ deliverable: Deliverable; onDone: () => void }>) {
  const { t, format } = useI18n();
  const d = t.flowGovernance.scope.deliverableDetail;
  const reject = useRejectDeliverable();
  const form = useForm<{ note: string }>({ defaultValues: { note: '' } });
  const submit = form.handleSubmit(async (values) => {
    try {
      await reject.mutateAsync({ id: deliverable.id, data: values.note.trim() ? { note: values.note.trim() } : {} });
      toast.success(d.toasts.rejected);
      onDone();
    } catch {
      toast.error(t.flowGovernance.common.actionFailed);
    }
  });
  return (
    <FormDialog
      open
      onClose={onDone}
      title={format(d.rejectTitle, { code: deliverable.code })}
      submitLabel={d.submitReject}
      pending={reject.isPending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        <TextAreaField control={form.control} name="note" label={d.rejectNote} />
      </Form>
    </FormDialog>
  );
}
