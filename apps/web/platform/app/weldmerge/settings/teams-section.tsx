import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeTeamDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useCreateMergeTeam,
  useDeleteMergeTeam,
  useMergeTeams,
  useUpdateMergeTeam,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../lib/format';

const DEFAULT_COLOR = '#6e56cf';

interface TeamFormValues {
  key: string;
  name: string;
  description: string;
  color: string;
}

function TeamFormDialog({
  open,
  onOpenChange,
  team,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; team: MergeTeamDto | null }>) {
  const { t } = useI18n();
  const tt = t.weldmerge.settings.teams;
  const create = useCreateMergeTeam();
  const update = useUpdateMergeTeam();
  const editing = team !== null;

  const schema = useMemo(
    () =>
      z.object({
        key: z
          .string()
          .trim()
          .min(1, tt.keyRequired)
          .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, tt.keyInvalid),
        name: z.string().trim().min(1, tt.nameRequired).max(255),
        description: z.string().trim().max(2000),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    [tt.keyRequired, tt.keyInvalid, tt.nameRequired],
  );
  const form = useForm<TeamFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { key: '', name: '', description: '', color: DEFAULT_COLOR },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      team
        ? { key: team.key, name: team.name, description: team.description ?? '', color: team.color ?? DEFAULT_COLOR }
        : { key: '', name: '', description: '', color: DEFAULT_COLOR },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, team?.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    const input = {
      key: values.key.toUpperCase(),
      name: values.name,
      description: values.description === '' ? null : values.description,
      color: values.color,
    };
    try {
      if (team) await update.mutateAsync({ id: team.id, input });
      else await create.mutateAsync(input);
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.status === 409) form.setError('key', { message: tt.keyConflict });
      else toast.error(tt.saveFailed);
    }
  });

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? tt.edit : tt.new}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tt.key}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      maxLength={10}
                      className="uppercase"
                      autoComplete="off"
                      onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                    />
                  </FormControl>
                  <FormDescription>{tt.keyHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tt.name}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tt.descriptionLabel}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="color"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tt.color}</FormLabel>
                  <FormControl>
                    <Input type="color" {...field} className="h-9 w-16 p-1" />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {editing ? tt.save : tt.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Teams: create, rename and recolour; the key is locked by the server once the team has issues. */
export function TeamsSection() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tt = tm.settings.teams;
  const canManage = useCan('merge_teams:manage');
  const teams = useMergeTeams();
  const remove = useDeleteMergeTeam();
  const [editing, setEditing] = useState<MergeTeamDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<MergeTeamDto | null>(null);

  if (teams.isLoading) return <PageLoader fullScreen={false} />;
  if (teams.isError) return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void teams.refetch()} />;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch (error) {
      toast.error(isApiError(error) && error.status === 409 ? tt.deleteBlocked : tt.deleteFailed);
      setDeleting(null);
    }
  };

  const rows = teams.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tt.title}</h2>
          <p className="text-sm text-muted-foreground">{tt.description}</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {tt.new}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Users} title={tt.empty} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((team) => (
            <li key={team.id}>
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <span className="size-3 rounded-full" style={{ backgroundColor: team.color ?? DEFAULT_COLOR }} />
                    {team.name}
                    <span className="rounded border px-1.5 text-xs font-normal text-muted-foreground">{team.key}</span>
                  </span>
                }
                action={
                  canManage ? (
                    <span className="flex">
                      <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.edit} onClick={() => setEditing(team)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.delete} onClick={() => setDeleting(team)}>
                        <Trash2 />
                      </Button>
                    </span>
                  ) : undefined
                }
              >
                <p className="text-sm text-muted-foreground">
                  {team.description ? `${team.description} · ` : ''}
                  {fill(tt.openIssues, { count: team.openIssueCount })}
                </p>
              </SectionCard>
            </li>
          ))}
        </ul>
      )}

      <TeamFormDialog open={creating} onOpenChange={setCreating} team={null} />
      <TeamFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} team={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tt.deleteTitle}
        description={tt.deleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
