import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeRepositoryDto, MergeTeamDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeReleaseDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { useCreateMergeRelease } from '@/hooks/queries/use-weldmerge-across-queries';
import { useI18n } from '@/lib/i18n/provider';

interface ReleaseFormValues {
  teamId: string;
  repositoryId: string;
  name: string;
  version: string;
  baseRef: string;
  headRef: string;
}

const emptyToNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * Creates a draft release: team, repository, name, version and the two refs
 * the merged pull requests are read between.
 */
export function ReleaseFormDialog({
  open,
  onOpenChange,
  teams,
  repositories,
  defaultTeamId,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: readonly MergeTeamDto[];
  repositories: readonly MergeRepositoryDto[];
  defaultTeamId?: string;
  onCreated?: (release: MergeReleaseDetailDto) => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldmerge.across.releases.form;
  const create = useCreateMergeRelease();

  const schema = useMemo(
    () =>
      z.object({
        teamId: z.string().min(1),
        repositoryId: z.string().min(1, tf.selectRepository),
        name: z.string().trim().min(1, tf.nameRequired).max(255),
        version: z.string().trim().max(100),
        baseRef: z.string().trim().max(500),
        headRef: z.string().trim().max(500),
      }),
    [tf.selectRepository, tf.nameRequired],
  );

  const form = useForm<ReleaseFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { teamId: '', repositoryId: '', name: '', version: '', baseRef: '', headRef: '' },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      teamId: defaultTeamId ?? teams[0]?.id ?? '',
      repositoryId: repositories.length === 1 ? (repositories[0]?.id ?? '') : '',
      name: '',
      version: '',
      baseRef: '',
      headRef: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const release = await create.mutateAsync({
        teamId: values.teamId,
        repositoryId: values.repositoryId,
        name: values.name,
        version: emptyToNull(values.version),
        baseRef: emptyToNull(values.baseRef),
        headRef: emptyToNull(values.headRef),
      });
      onOpenChange(false);
      onCreated?.(release);
    } catch {
      toast.error(tf.createFailed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tf.title}</DialogTitle>
          <DialogDescription>{tf.refsHint}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
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
              <FormField
                control={form.control}
                name="repositoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.repository}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // A repository that belongs to a team brings the team along.
                        const teamId = repositories.find((repo) => repo.id === value)?.teamId;
                        if (teamId) form.setValue('teamId', teamId);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={tf.selectRepository} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {repositories.map((repo) => (
                          <SelectItem key={repo.id} value={repo.id}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.name}</FormLabel>
                    <FormControl>
                      <Input {...field} autoFocus placeholder={tf.namePlaceholder} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="version"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.version}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={tf.versionPlaceholder} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="baseRef"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.baseRef}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={tf.baseRefPlaceholder} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="headRef"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.headRef}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={tf.headRefPlaceholder} />
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
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />}
                {tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
