import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateDelegation, useDelegations, useDeleteDelegation } from '@/hooks/queries/use-flow-approvals-queries';
import { formatDate } from '@/app/weldflow/_approvals/format';
import type { MemberOption } from '@/app/weldflow/_approvals/use-member-names';

interface DelegationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: MemberOption[];
  currentUserId?: string | null;
  nameOf: (userId: string | null | undefined) => string;
}

function toIso(localDate: string, endOfDay: boolean): string {
  return new Date(`${localDate}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString();
}

/** Hand the caller's reviews to a member for a period, and list the delegations in force. */
export function DelegationDialog({ open, onOpenChange, members, currentUserId, nameOf }: Readonly<DelegationDialogProps>) {
  const { t, language } = useI18n();
  const copy = t.flowApprovals.reviews.delegation;
  const create = useCreateDelegation();
  const remove = useDeleteDelegation();
  const delegations = useDelegations();

  const schema = z
    .object({
      delegateId: z.string().min(1, copy.delegateRequired),
      startsAt: z.string().min(1, copy.periodInvalid),
      endsAt: z.string().min(1, copy.periodInvalid),
    })
    .refine((value) => !value.startsAt || !value.endsAt || value.endsAt >= value.startsAt, { path: ['endsAt'], message: copy.periodInvalid });
  type Values = z.infer<typeof schema>;
  const today = new Date().toISOString().slice(0, 10);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { delegateId: '', startsAt: today, endsAt: today } });

  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync({ delegateId: values.delegateId, startsAt: toIso(values.startsAt, false), endsAt: toIso(values.endsAt, true) });
      toast.success(copy.created);
      form.reset();
    } catch {
      toast.error(copy.failed);
    }
  });

  const options = members.filter((member) => member.userId !== currentUserId);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="delegate-member">
              {copy.delegate}
            </label>
            <Select value={form.watch('delegateId')} onValueChange={(value) => form.setValue('delegateId', value, { shouldValidate: true })}>
              <SelectTrigger id="delegate-member">
                <SelectValue placeholder={copy.chooseMember} />
              </SelectTrigger>
              <SelectContent>
                {options.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.delegateId ? <p role="alert" className="text-xs text-destructive">{errors.delegateId.message}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="delegate-start">{copy.start}</label>
              <Input id="delegate-start" type="date" {...form.register('startsAt')} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="delegate-end">{copy.end}</label>
              <Input id="delegate-end" type="date" {...form.register('endsAt')} />
              {errors.endsAt ? <p role="alert" className="text-xs text-destructive">{errors.endsAt.message}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.flowApprovals.common.close}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {copy.create}
            </Button>
          </DialogFooter>
        </form>

        <div className="space-y-2 border-t pt-3 text-sm">
          {[
            { key: 'given', label: copy.given, rows: delegations.data?.given ?? [], who: (row: { delegateId: string }) => row.delegateId, mine: true },
            { key: 'received', label: copy.received, rows: delegations.data?.received ?? [], who: (row: { memberId: string }) => row.memberId, mine: false },
          ].map((group) =>
            group.rows.length > 0 ? (
              <div key={group.key}>
                <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
                <ul className="space-y-1">
                  {(group.rows as Array<{ id: string; delegateId: string; memberId: string; startsAt: string; endsAt: string }>).map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2">
                      <span>
                        {nameOf(group.mine ? row.delegateId : row.memberId)} · {formatDate(row.startsAt, language)} - {formatDate(row.endsAt, language)}
                      </span>
                      {group.mine ? (
                        <Button type="button" variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(row.id, { onSuccess: () => toast.success(copy.ended) })}>
                          {copy.endAction}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {(delegations.data?.given.length ?? 0) + (delegations.data?.received.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{copy.none}</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
