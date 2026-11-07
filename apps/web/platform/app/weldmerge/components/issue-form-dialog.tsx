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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  MERGE_ISSUE_PRIORITIES,
  MERGE_ISSUE_STATUSES,
  type MergeIssueDto,
  type MergeIssuePriority,
  type MergeIssueStatus,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { MemberSelect } from '@/components/team/member-select';
import {
  useCreateMergeIssue,
  useMergeCycles,
  useMergeLabels,
  useMergeTeams,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill, formatDateRange } from '../lib/format';
import { IssueStatusIcon, PriorityBars } from './primitives';

const NO_CYCLE = '__none__';

interface IssueFormValues {
  teamId: string;
  title: string;
  description: string;
  status: MergeIssueStatus;
  priority: string;
  assigneeUserId: string;
  labelIds: string[];
  cycleId: string;
}

/**
 * The "New issue" dialog: team, title, description, status, priority, assignee,
 * labels and cycle. `defaultTeamId` pre-selects the team being viewed;
 * `parentIssueId` makes the new issue a sub-issue.
 */
export function IssueFormDialog({
  open,
  onOpenChange,
  defaultTeamId,
  defaultStatus = 'backlog',
  parentIssueId,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTeamId?: string;
  defaultStatus?: MergeIssueStatus;
  parentIssueId?: string;
  onCreated?: (issue: MergeIssueDto) => void;
}>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tf = tm.issues.form;
  const teams = useMergeTeams();
  const create = useCreateMergeIssue();

  const schema = useMemo(
    () =>
      z.object({
        teamId: z.string().min(1, tf.teamRequired),
        title: z.string().trim().min(1, tf.titleRequired).max(500),
        description: z.string().max(100_000),
        status: z.enum(MERGE_ISSUE_STATUSES),
        priority: z.string(),
        assigneeUserId: z.string(),
        labelIds: z.array(z.string()).max(20),
        cycleId: z.string(),
      }),
    [tf.teamRequired, tf.titleRequired],
  );

  const form = useForm<IssueFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      teamId: defaultTeamId ?? '',
      title: '',
      description: '',
      status: defaultStatus,
      priority: '0',
      assigneeUserId: '',
      labelIds: [],
      cycleId: NO_CYCLE,
    },
  });

  // A fresh form each time the dialog opens; the team follows the page's team.
  useEffect(() => {
    if (open) {
      form.reset({
        teamId: defaultTeamId ?? teams.data?.[0]?.id ?? '',
        title: '',
        description: '',
        status: defaultStatus,
        priority: '0',
        assigneeUserId: '',
        labelIds: [],
        cycleId: NO_CYCLE,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  // With no team chosen yet, take the only team (or the first) once teams load.
  const teamId = form.watch('teamId');
  useEffect(() => {
    if (open && !teamId && teams.data?.[0]) form.setValue('teamId', teams.data[0].id);
  }, [open, teamId, teams.data, form]);

  const labels = useMergeLabels(teamId || undefined);
  const cycles = useMergeCycles(teamId || undefined);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const issue = await create.mutateAsync({
        teamId: values.teamId,
        title: values.title,
        description: values.description.trim() === '' ? null : values.description,
        status: values.status,
        priority: Number(values.priority) as MergeIssuePriority,
        assigneeUserId: values.assigneeUserId === '' ? null : values.assigneeUserId,
        labelIds: values.labelIds,
        cycleId: values.cycleId === NO_CYCLE ? null : values.cycleId,
        parentIssueId: parentIssueId ?? null,
      });
      toast.success(fill(tm.issues.created, { key: issue.key }));
      onOpenChange(false);
      onCreated?.(issue);
    } catch {
      toast.error(tm.issues.createFailed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tf.title}</DialogTitle>
          <DialogDescription>{tf.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {!parentIssueId && (
              <FormField
                control={form.control}
                name="teamId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.team}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Labels and cycles belong to the team.
                        form.setValue('labelIds', []);
                        form.setValue('cycleId', NO_CYCLE);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(teams.data ?? []).map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name} ({team.key})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.titleLabel}</FormLabel>
                  <FormControl>
                    <Input {...field} autoFocus placeholder={tf.titlePlaceholder} />
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
                  <FormLabel>{tf.descriptionLabel}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={4} placeholder={tf.descriptionPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.status}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MERGE_ISSUE_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            <span className="flex items-center gap-2">
                              <IssueStatusIcon status={status} />
                              {tm.status[status]}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.priority}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MERGE_ISSUE_PRIORITIES.map((priority) => (
                          <SelectItem key={priority} value={String(priority)}>
                            <span className="flex items-center gap-2">
                              <PriorityBars priority={priority} />
                              {tm.priority[priority]}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="assigneeUserId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.assignee}</FormLabel>
                    <MemberSelect
                      variant="assignee"
                      value={field.value || undefined}
                      onChange={field.onChange}
                      placeholder={tm.unassigned}
                    />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cycleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.cycle}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_CYCLE}>{tf.noCycle}</SelectItem>
                        {(cycles.data ?? []).map((cycle) => (
                          <SelectItem key={cycle.id} value={cycle.id}>
                            {cycle.name?.trim() || fill(tm.cycles.cycleName, { number: cycle.number })} ·{' '}
                            {formatDateRange(cycle.startsAt, cycle.endsAt, language)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="labelIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.labels}</FormLabel>
                  <MultiSelect
                    modal
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={tf.labelsPlaceholder}
                    options={(labels.data ?? []).map((label) => ({ value: label.id, label: label.name }))}
                  />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />}
                {create.isPending ? tf.creating : tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
