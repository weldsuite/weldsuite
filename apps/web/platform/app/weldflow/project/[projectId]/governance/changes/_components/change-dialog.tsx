import { useEffect } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { ChangeRequestDetail } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateChangeRequest, useUpdateChangeRequest } from '@/hooks/queries/use-flow-approvals-queries';
import { useProjectMilestones } from '@/hooks/queries/use-project-control-queries';
import { changeBodyFrom, changeFormFrom, changeFormSchema, emptyChangeForm, type ChangeFormValues } from './change-form';

interface ChangeDialogProps {
  projectId: string;
  currency: string | null;
  /** The change being edited; null creates a new one. The dialog is open while `open`. */
  change: ChangeRequestDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (id: string) => void;
}

/** Create or edit a change request: its words, its impact and the plan and scope changes. */
export function ChangeDialog({ projectId, currency, change, open, onOpenChange, onSaved }: Readonly<ChangeDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.flowApprovals.changes;
  const create = useCreateChangeRequest();
  const update = useUpdateChangeRequest();
  const milestones = useProjectMilestones(projectId, open);
  const form = useForm<ChangeFormValues>({
    resolver: zodResolver(changeFormSchema({ titleRequired: copy.form.titleRequired, numberInvalid: copy.form.numberInvalid })),
    defaultValues: emptyChangeForm(),
  });
  const moves = useFieldArray({ control: form.control, name: 'milestoneMoves' });
  const adds = useFieldArray({ control: form.control, name: 'addDeliverables' });

  useEffect(() => {
    if (open) form.reset(change ? changeFormFrom(change) : emptyChangeForm());
  }, [open, change, form]);

  const pending = create.isPending || update.isPending;
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async (values) => {
    const body = changeBodyFrom(values, change ?? undefined);
    try {
      const saved = change ? await update.mutateAsync({ id: change.id, ...body }) : await create.mutateAsync({ projectId, ...body });
      toast.success(copy.form.saved);
      onSaved(saved.data.id);
      onOpenChange(false);
    } catch (error) {
      toast.error(isApiError(error) && error.message ? error.message : copy.form.failed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 pb-4 pt-6 text-left">
          <DialogTitle>{change ? format(copy.form.editTitle, { code: change.code }) : copy.form.createTitle}</DialogTitle>
          {change?.status === 'awaiting_approval' ? <DialogDescription>{copy.actions.editWarning}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chg-title">{copy.form.title}</label>
              <Input id="chg-title" autoFocus {...form.register('title')} aria-invalid={!!errors.title} />
              {errors.title ? <p role="alert" className="text-xs text-destructive">{errors.title.message}</p> : null}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chg-description">{copy.form.description}</label>
              <Textarea id="chg-description" rows={3} {...form.register('description')} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="chg-cost">{format(copy.form.costDelta, { currency: currency ?? '' }).replace(' ()', '')}</label>
                <Input id="chg-cost" inputMode="decimal" {...form.register('costDelta')} aria-invalid={!!errors.costDelta} />
                <p className="text-xs text-muted-foreground">{copy.form.costHint}</p>
                {errors.costDelta ? <p role="alert" className="text-xs text-destructive">{errors.costDelta.message}</p> : null}
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="chg-days">{copy.form.scheduleDelta}</label>
                <Input id="chg-days" inputMode="numeric" {...form.register('scheduleDeltaDays')} aria-invalid={!!errors.scheduleDeltaDays} />
                <p className="text-xs text-muted-foreground">{copy.form.scheduleHint}</p>
                {errors.scheduleDeltaDays ? <p role="alert" className="text-xs text-destructive">{errors.scheduleDeltaDays.message}</p> : null}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chg-golive">{copy.form.goLive}</label>
              <Input id="chg-golive" type="date" className="sm:w-48" {...form.register('goLive')} />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{copy.form.milestones}</legend>
              {moves.fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <Select value={form.watch(`milestoneMoves.${index}.milestoneId`)} onValueChange={(value) => form.setValue(`milestoneMoves.${index}.milestoneId`, value, { shouldValidate: true })}>
                    <SelectTrigger className="min-w-0 flex-1" aria-label={copy.form.milestone}>
                      <SelectValue placeholder={copy.form.milestone} />
                    </SelectTrigger>
                    <SelectContent>
                      {(milestones.data ?? []).map((milestone) => (
                        <SelectItem key={milestone.id} value={milestone.id}>
                          {milestone.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input type="date" className="w-40" aria-label={copy.form.newDate} {...form.register(`milestoneMoves.${index}.to`)} />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => moves.remove(index)} aria-label={copy.form.remove}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => moves.append({ milestoneId: '', to: '' })}>
                <Plus aria-hidden />
                {copy.form.addMilestone}
              </Button>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{copy.form.scopeAdd}</legend>
              {adds.fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <Input aria-label={copy.form.deliverableTitle} placeholder={copy.form.deliverableTitle} {...form.register(`addDeliverables.${index}.title`)} />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => adds.remove(index)} aria-label={copy.form.remove}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              {errors.addDeliverables ? <p role="alert" className="text-xs text-destructive">{copy.form.titleRequired}</p> : null}
              <Button type="button" variant="outline" size="sm" onClick={() => adds.append({ title: '' })}>
                <Plus aria-hidden />
                {copy.form.addDeliverable}
              </Button>
              <p className="text-xs text-muted-foreground">{copy.form.deliverablesGap}</p>
            </fieldset>
          </div>
          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.flowApprovals.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {change ? copy.form.saveChanges : copy.form.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
