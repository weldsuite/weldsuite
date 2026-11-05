import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { ChangeControlResponse } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useI18n } from '@/lib/i18n/provider';
import { useSetChangeControl, useSetProjectSponsor } from '@/hooks/queries/use-flow-approvals-queries';
import type { MemberOption } from '@/app/weldflow/_approvals/use-member-names';

const NO_SPONSOR = '__none__';

interface RulesFormProps {
  projectId: string;
  control: ChangeControlResponse;
  /** Project members (a viewer is enough for the board and the sponsor). */
  members: MemberOption[];
  /** Only a project manager edits the rules; everybody else reads them. */
  canEdit: boolean;
  /** Cancel or Close, and after the limits and the board were saved. */
  onClose: () => void;
}

/** The approval rules of a project: the two limits, the change board and the sponsor. */
export function RulesForm({ projectId, control, members, canEdit, onClose }: Readonly<RulesFormProps>) {
  const { t, format } = useI18n();
  const copy = t.flowApprovals.changes.rules;
  const save = useSetChangeControl(projectId);
  const setSponsor = useSetProjectSponsor(projectId);
  const nameOf = (userId: string) => members.find((member) => member.userId === userId)?.name ?? userId;

  const schema = z.object({
    costLimit: z.coerce.number({ invalid_type_error: copy.costRequired }).min(0, copy.costRequired),
    scheduleLimitDays: z.coerce.number({ invalid_type_error: copy.daysRequired }).int(copy.daysRequired).min(0, copy.daysRequired),
    boardMemberIds: z.array(z.string()),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { costLimit: control.changeControl.costLimit, scheduleLimitDays: control.changeControl.scheduleLimitDays, boardMemberIds: control.changeControl.boardMemberIds },
  });
  useEffect(() => {
    form.reset({ costLimit: control.changeControl.costLimit, scheduleLimitDays: control.changeControl.scheduleLimitDays, boardMemberIds: control.changeControl.boardMemberIds });
  }, [control, form]);

  const board = form.watch('boardMemberIds');
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async (values) => {
    try {
      await save.mutateAsync({ costLimit: values.costLimit, scheduleLimitDays: values.scheduleLimitDays, boardMemberIds: values.boardMemberIds });
      toast.success(copy.saved);
      onClose();
    } catch {
      toast.error(copy.saveFailed);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col" data-testid="rules-form">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {control.warnings.includes('no_board') ? <InfoBanner variant="warning">{copy.noBoardWarning}</InfoBanner> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="rule-cost">
              {format(copy.costLimit, { currency: control.currency ?? '' }).trim()}
            </label>
            <Input id="rule-cost" type="number" step="any" disabled={!canEdit} {...form.register('costLimit')} />
            {errors.costLimit ? <p role="alert" className="text-xs text-destructive">{errors.costLimit.message}</p> : null}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="rule-days">
              {copy.scheduleLimit}
            </label>
            <Input id="rule-days" type="number" step={1} disabled={!canEdit} {...form.register('scheduleLimitDays')} />
            {errors.scheduleLimitDays ? <p role="alert" className="text-xs text-destructive">{errors.scheduleLimitDays.message}</p> : null}
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">{copy.board}</p>
          <p className="text-xs text-muted-foreground">{copy.boardHint}</p>
          {board.length === 0 ? (
            <p className="py-1.5 text-sm text-muted-foreground">{copy.noBoard}</p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {board.map((userId) => (
                <li key={userId} className="flex items-center justify-between gap-2 py-1 text-sm">
                  <span className="min-w-0 truncate">{nameOf(userId)}</span>
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t.flowApprovals.changes.form.remove} ${nameOf(userId)}`}
                      onClick={() => form.setValue('boardMemberIds', board.filter((id) => id !== userId), { shouldDirty: true })}
                    >
                      <X aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <Select value="" onValueChange={(value) => form.setValue('boardMemberIds', [...board, value], { shouldDirty: true })}>
              <SelectTrigger className="mt-2 w-full sm:w-64" aria-label={copy.addBoardMember}>
                <SelectValue placeholder={copy.addBoardMember} />
              </SelectTrigger>
              <SelectContent>
                {members
                  .filter((member) => !board.includes(member.userId))
                  .map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="rule-sponsor">
            {copy.sponsor}
          </label>
          <Select
            value={control.sponsorId ?? NO_SPONSOR}
            disabled={!canEdit || setSponsor.isPending}
            onValueChange={(value) =>
              setSponsor.mutate(value === NO_SPONSOR ? null : value, { onSuccess: () => toast.success(copy.saved), onError: () => toast.error(copy.saveFailed) })
            }
          >
            <SelectTrigger id="rule-sponsor" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SPONSOR}>{copy.noSponsor}</SelectItem>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{copy.sponsorHint}</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        {canEdit ? (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowApprovals.common.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {copy.save}
            </Button>
          </>
        ) : (
          <>
            <p className="mr-auto text-xs text-muted-foreground">{copy.managerOnly}</p>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowApprovals.common.close}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

interface RulesDialogProps extends Omit<RulesFormProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The approval rules in a dialog, opened from the toolbar of the change requests page. */
export function RulesDialog({ open, onOpenChange, ...form }: Readonly<RulesDialogProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes.rules;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 pb-4 pt-6 text-left">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <RulesForm {...form} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
