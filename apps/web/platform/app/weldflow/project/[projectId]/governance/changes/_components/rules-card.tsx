import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { ChangeControlResponse } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useI18n } from '@/lib/i18n/provider';
import { useSetChangeControl, useSetProjectSponsor } from '@/hooks/queries/use-flow-approvals-queries';
import type { MemberOption } from '@/app/weldflow/_approvals/use-member-names';

const NO_SPONSOR = '__none__';

interface RulesCardProps {
  projectId: string;
  control: ChangeControlResponse;
  /** Project members (a viewer is enough for the board and the sponsor). */
  members: MemberOption[];
  /** Only a project manager edits the rules; everybody else reads them. */
  canEdit: boolean;
}

/** The approval rules of a project: the two limits, the change board and the sponsor. */
export function RulesCard({ projectId, control, members, canEdit }: Readonly<RulesCardProps>) {
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
    } catch {
      toast.error(copy.saveFailed);
    }
  });

  return (
    <section className="rounded-lg border" aria-labelledby="change-rules-title" data-testid="rules-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 id="change-rules-title" className="text-sm font-semibold">
          {copy.title}
        </h2>
        {control.warnings.includes('no_board') ? (
          <Badge variant="outline" className="gap-1 border-amber-500 text-amber-700 dark:text-amber-400" title={copy.noBoardWarning}>
            <AlertTriangle className="size-3" aria-hidden />
            {copy.noBoard}
          </Badge>
        ) : null}
      </div>
      <form onSubmit={submit} className="space-y-3 px-4 py-3" noValidate>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
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
          <div className="flex flex-wrap gap-1.5">
            {board.length === 0 ? <span className="text-xs text-muted-foreground">{copy.noBoard}</span> : null}
            {board.map((userId) => (
              <Badge key={userId} variant="secondary" className="gap-1">
                {nameOf(userId)}
                {canEdit ? (
                  <button type="button" aria-label={`${t.flowApprovals.changes.form.remove} ${nameOf(userId)}`} onClick={() => form.setValue('boardMemberIds', board.filter((id) => id !== userId), { shouldDirty: true })}>
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </Badge>
            ))}
          </div>
          {canEdit ? (
            <Select value="" onValueChange={(value) => form.setValue('boardMemberIds', [...board, value], { shouldDirty: true })}>
              <SelectTrigger className="w-full sm:w-64" aria-label={copy.addBoardMember}>
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

        {canEdit ? (
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {copy.save}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{copy.managerOnly}</p>
        )}
      </form>
    </section>
  );
}
