import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeCycleDto, MergeTeamDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useCreateMergeCycle, useUpdateMergeCycle } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { todayIso } from '../lib/format';

interface CycleFormValues {
  teamId: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

/** Create a cycle for a team, or edit the name and dates of an existing one. */
export function CycleFormDialog({
  open,
  onOpenChange,
  teams,
  defaultTeamId,
  cycle,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: readonly MergeTeamDto[];
  defaultTeamId?: string;
  /** The cycle being edited; omitted to create one. */
  cycle?: MergeCycleDto | null;
}>) {
  const { t } = useI18n();
  const tf = t.weldmerge.cycles.form;
  const create = useCreateMergeCycle();
  const update = useUpdateMergeCycle();
  const editing = !!cycle;

  const schema = useMemo(
    () =>
      z
        .object({
          teamId: z.string().min(1),
          name: z.string().trim().max(255),
          startsAt: z.string().min(1, tf.startsRequired),
          endsAt: z.string().min(1, tf.endsRequired),
        })
        .refine((v) => !v.startsAt || !v.endsAt || v.endsAt >= v.startsAt, { message: tf.endsBeforeStart, path: ['endsAt'] }),
    [tf.startsRequired, tf.endsRequired, tf.endsBeforeStart],
  );

  const form = useForm<CycleFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { teamId: '', name: '', startsAt: '', endsAt: '' },
  });

  useEffect(() => {
    if (!open) return;
    if (cycle) {
      form.reset({ teamId: cycle.teamId, name: cycle.name ?? '', startsAt: cycle.startsAt, endsAt: cycle.endsAt });
    } else {
      const start = todayIso();
      const end = todayIso(new Date(Date.now() + 13 * 24 * 3600 * 1000));
      form.reset({ teamId: defaultTeamId ?? teams[0]?.id ?? '', name: '', startsAt: start, endsAt: end });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, cycle?.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (cycle) {
        await update.mutateAsync({
          id: cycle.id,
          input: { name: values.name === '' ? null : values.name, startsAt: values.startsAt, endsAt: values.endsAt },
        });
      } else {
        await create.mutateAsync({
          teamId: values.teamId,
          name: values.name === '' ? null : values.name,
          startsAt: values.startsAt,
          endsAt: values.endsAt,
        });
      }
      onOpenChange(false);
    } catch {
      toast.error(t.weldmerge.cycles.saveFailed);
    }
  });

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? t.weldmerge.cycles.editCycle : t.weldmerge.cycles.newCycle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {!editing && (
              <FormField
                control={form.control}
                name="teamId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.team}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {teams.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name} ({team.key})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.name}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tf.namePlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="startsAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.startsAt}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endsAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.endsAt}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {editing ? tf.save : tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
