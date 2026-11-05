/**
 * The dialogs of the stakeholder register: add one, edit one, and confirm
 * removing one. The page and the stakeholder panel both open them, so each
 * takes what it needs as props and holds no page state.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { useI18n } from '@/lib/i18n/provider';
import { useAllTeamMembers } from '@/hooks/queries/use-team-queries';
import { CrmPersonSelect } from '@/components/objects/person/crm-person-select';
import { useCreateStakeholder, useDeleteStakeholder, useUpdateStakeholder } from '@/hooks/queries/use-project-reporting-queries';
import { FormDialog } from '../../_components/parts';
import { SelectField, TextAreaField, TextField, type SelectOption } from '../../../raid/_components/form-fields';
import {
  SCORES,
  buildCreateInput,
  buildUpdateInput,
  defaultStakeholderValues,
  stakeholderFormSchema,
  valuesFromStakeholder,
  type StakeholderFormValues,
} from './stakeholder-form';
import { stakeholderName } from './stakeholder-model';

export type StakeholderDialogState = { mode: 'create' } | { mode: 'edit'; row: Stakeholder };

interface StakeholderDialogProps {
  projectId: string;
  /** The register as listed, to leave the people already on it out of the choices. */
  existing?: readonly Stakeholder[];
  state: StakeholderDialogState | null;
  onClose: () => void;
}

/** The add and edit dialog; render it once and hand it the stakeholder to edit (or `create`). */
export function StakeholderDialog({ state, ...props }: Readonly<StakeholderDialogProps>) {
  if (!state) return null;
  return <StakeholderForm key={state.mode === 'edit' ? state.row.id : 'new'} state={state} {...props} />;
}

function StakeholderForm({ projectId, existing = [], state, onClose }: Readonly<StakeholderDialogProps & { state: StakeholderDialogState }>) {
  const { t, format } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const members = useAllTeamMembers({ status: 'ACTIVE' });
  const create = useCreateStakeholder();
  const update = useUpdateStakeholder();
  const edit = state.mode === 'edit' ? state.row : null;

  const schema = useMemo(
    () =>
      stakeholderFormSchema(
        { required: t.flowGovernance.common.required, tooLong: (max) => format(copy.form.tooLong, { max }) },
        state.mode,
      ),
    [t, format, copy, state.mode],
  );
  const form = useForm<StakeholderFormValues>({
    resolver: zodResolver(schema),
    defaultValues: edit ? valuesFromStakeholder(edit) : defaultStakeholderValues(),
  });
  const kind = form.watch('kind');

  const taken = new Set(existing.flatMap((row) => (row.memberId ? [row.memberId] : [])));
  const takenContacts = useMemo(() => new Set(existing.flatMap((row) => (row.crmContactId ? [row.crmContactId] : []))), [existing]);
  const memberOptions: SelectOption[] = (members.data ?? [])
    .filter((member) => !taken.has(member.userId))
    .map((member) => ({ value: member.userId, label: member.name ?? member.userId }));
  const kindOptions: SelectOption[] = [
    { value: 'member', label: copy.form.member },
    { value: 'contact', label: copy.form.contact },
  ];
  const scoreOptions: SelectOption[] = SCORES.map((score) => ({ value: String(score), label: `${score}/5` }));
  const attitudeOptions: SelectOption[] = Object.entries(copy.attitudes).map(([value, label]) => ({ value, label }));
  const engagementOptions: SelectOption[] = Object.entries(copy.engagements).map(([value, label]) => ({ value, label }));

  const submit = form.handleSubmit(async (values) => {
    try {
      if (edit) {
        await update.mutateAsync({ id: edit.id, input: buildUpdateInput(edit, values) });
        toast.success(copy.toasts.updated);
      } else {
        await create.mutateAsync(buildCreateInput(projectId, values));
        toast.success(copy.toasts.added);
      }
      onClose();
    } catch {
      toast.error(copy.saveFailed);
    }
  });

  return (
    <Form {...form}>
      <FormDialog
        open
        onClose={onClose}
        title={edit ? copy.editTitle : copy.add}
        description={edit ? stakeholderName(edit) : undefined}
        submitLabel={copy.form.save}
        pending={create.isPending || update.isPending}
        onSubmit={() => void submit()}
      >
        {edit ? null : (
          <>
            <SelectField control={form.control} name="kind" label={copy.form.kind} options={kindOptions} />
            {kind === 'member' ? (
              <SelectField control={form.control} name="memberId" label={copy.form.member} options={memberOptions} placeholder={copy.form.choose} />
            ) : (
              <FormField
                control={form.control}
                name="contactId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{copy.form.contact}</FormLabel>
                    <FormControl>
                      <CrmPersonSelect
                        value={field.value}
                        placeholder={copy.form.choosePerson}
                        searchPlaceholder={copy.form.searchPeople}
                        excludeIds={takenContacts}
                        onChange={(personId, person) => {
                          field.onChange(personId);
                          // Take the job title as the role unless one was typed already.
                          if (person?.title && !form.getValues('role').trim()) form.setValue('role', person.title);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField control={form.control} name="role" label={copy.form.role} />
          <TextField control={form.control} name="organisation" label={copy.form.organisation} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField control={form.control} name="influence" label={copy.columns.influence} options={scoreOptions} />
          <SelectField control={form.control} name="interest" label={copy.columns.interest} options={scoreOptions} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField control={form.control} name="attitude" label={copy.columns.attitude} options={attitudeOptions} />
          <SelectField control={form.control} name="engagement" label={copy.columns.engagement} options={engagementOptions} />
        </div>
        <TextField control={form.control} name="lastContact" label={copy.columns.lastContact} type="date" />
        <TextAreaField control={form.control} name="notes" label={copy.form.notes} rows={3} />
      </FormDialog>
    </Form>
  );
}

interface RemoveStakeholderDialogProps {
  /** The stakeholder to remove; null keeps the dialog closed. */
  row: Stakeholder | null;
  onClose: () => void;
  /** Called once the stakeholder is gone, before the dialog closes. */
  onRemoved?: (row: Stakeholder) => void;
}

/** Confirm taking a stakeholder (and their RACI cells) off the register. */
export function RemoveStakeholderDialog({ row, onClose, onRemoved }: Readonly<RemoveStakeholderDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const remove = useDeleteStakeholder();

  const confirm = async () => {
    if (!row) return;
    try {
      await remove.mutateAsync(row.id);
      toast.success(copy.toasts.removed);
      onRemoved?.(row);
      onClose();
    } catch {
      toast.error(copy.saveFailed);
    }
  };

  return (
    <ConfirmDialog
      open={row !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={row ? format(copy.removeTitle, { name: stakeholderName(row) }) : ''}
      description={copy.form.removeConfirm}
      confirmLabel={t.flowGovernance.common.remove}
      cancelLabel={t.flowGovernance.common.cancel}
      variant="destructive"
      loading={remove.isPending}
      onConfirm={confirm}
    />
  );
}
