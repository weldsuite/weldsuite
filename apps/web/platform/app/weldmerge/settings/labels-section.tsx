import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeLabelDto, MergeTeamDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useCreateMergeLabel,
  useDeleteMergeLabel,
  useMergeLabels,
  useMergeTeams,
  useUpdateMergeLabel,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabelChip } from '../components/primitives';

const WORKSPACE_WIDE = '__workspace__';
const DEFAULT_COLOR = '#94a3b8';

interface LabelFormValues {
  name: string;
  color: string;
  teamId: string;
}

function LabelFormDialog({
  open,
  onOpenChange,
  label,
  teams,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: MergeLabelDto | null;
  teams: readonly MergeTeamDto[];
}>) {
  const { t } = useI18n();
  const tl = t.weldmerge.settings.labels;
  const create = useCreateMergeLabel();
  const update = useUpdateMergeLabel();
  const editing = label !== null;

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, tl.nameRequired).max(100),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        teamId: z.string(),
      }),
    [tl.nameRequired],
  );
  const form = useForm<LabelFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', color: DEFAULT_COLOR, teamId: WORKSPACE_WIDE },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      label
        ? { name: label.name, color: label.color ?? DEFAULT_COLOR, teamId: label.teamId ?? WORKSPACE_WIDE }
        : { name: '', color: DEFAULT_COLOR, teamId: WORKSPACE_WIDE },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open, label?.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (label) await update.mutateAsync({ id: label.id, input: { name: values.name, color: values.color } });
      else {
        await create.mutateAsync({
          name: values.name,
          color: values.color,
          teamId: values.teamId === WORKSPACE_WIDE ? null : values.teamId,
        });
      }
      onOpenChange(false);
    } catch {
      toast.error(tl.saveFailed);
    }
  });

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? tl.edit : tl.new}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tl.name}</FormLabel>
                  <FormControl>
                    <Input {...field} autoFocus />
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
                  <FormLabel>{tl.color}</FormLabel>
                  <FormControl>
                    <Input type="color" {...field} className="h-9 w-16 p-1" />
                  </FormControl>
                </FormItem>
              )}
            />
            {!editing && (
              <FormField
                control={form.control}
                name="teamId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tl.team}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={WORKSPACE_WIDE}>{tl.workspaceWide}</SelectItem>
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {editing ? tl.save : tl.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Labels, workspace-wide or per team; managed with `merge_teams:manage`. */
export function LabelsSection() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tl = tm.settings.labels;
  const canManage = useCan('merge_teams:manage');
  const labels = useMergeLabels();
  const teams = useMergeTeams();
  const remove = useDeleteMergeLabel();
  const [editing, setEditing] = useState<MergeLabelDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<MergeLabelDto | null>(null);
  const teamById = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team])), [teams.data]);

  if (labels.isLoading) return <PageLoader fullScreen={false} />;
  if (labels.isError) return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void labels.refetch()} />;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch {
      toast.error(tl.deleteFailed);
    }
  };

  const rows = labels.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tl.title}</h2>
          <p className="text-sm text-muted-foreground">{tl.description}</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {tl.new}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Tag} title={tl.empty} />
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((label) => (
            <li key={label.id} className="flex items-center gap-3 px-3 py-2">
              <LabelChip name={label.name} color={label.color} />
              <span className="flex-1 text-sm text-muted-foreground">
                {label.teamId ? (teamById.get(label.teamId)?.name ?? '') : tl.workspaceWide}
              </span>
              {canManage && (
                <span className="flex">
                  <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.edit} onClick={() => setEditing(label)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.delete} onClick={() => setDeleting(label)}>
                    <Trash2 />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <LabelFormDialog open={creating} onOpenChange={setCreating} label={null} teams={teams.data ?? []} />
      <LabelFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        label={editing}
        teams={teams.data ?? []}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tl.deleteTitle}
        description={tl.deleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
