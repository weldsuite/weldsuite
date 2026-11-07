import { useMemo, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { MergeExternalIssueDto, MergeIssueDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useMergeRepositories } from '@/hooks/queries/use-weldmerge-queries';
import { useCreateMergeExternalIssue, useRemoveMergeExternalIssue } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../lib/format';
import { ProviderLogo } from './provider-logo';

function LinkedIssue({ external, issueId }: Readonly<{ external: MergeExternalIssueDto; issueId: string }>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const te = tm.sync.externalSync;
  const canUpdate = useCan('merge_issues:update');
  const remove = useRemoveMergeExternalIssue(issueId);
  const [confirming, setConfirming] = useState(false);
  const providerName = tm.provider[external.provider];

  const unlink = async () => {
    try {
      await remove.mutateAsync();
      setConfirming(false);
    } catch {
      toast.error(te.unlinkFailed);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProviderLogo provider={external.provider} />
        <a
          href={external.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {external.repositoryFullName} #{external.number}
        </a>
        <SoftBadge tone={external.state === 'open' ? 'success' : 'neutral'}>
          {external.state === 'open' ? te.stateOpen : te.stateClosed}
        </SoftBadge>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href={external.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            {fill(te.openOn, { provider: providerName })}
          </a>
        </Button>
        {canUpdate && (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            {te.unlink}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={te.unlinkTitle}
        description={fill(te.unlinkDescription, { provider: providerName })}
        confirmLabel={te.unlink}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={unlink}
      />
    </div>
  );
}

function CreateOnProvider({ issue }: Readonly<{ issue: MergeIssueDetailDto }>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const te = tm.sync.externalSync;
  const repositories = useMergeRepositories();
  const create = useCreateMergeExternalIssue(issue.id);
  const [chosen, setChosen] = useState<string>('');

  const twoWay = useMemo(
    () => (repositories.data ?? []).filter((repo) => repo.issueSync === 'two_way'),
    [repositories.data],
  );
  // The team's own repository when there is exactly one, else the member chooses.
  const preferred = twoWay.filter((repo) => repo.teamId === issue.teamId);
  const repositoryId = chosen || (preferred.length === 1 ? (preferred[0]?.id ?? '') : '');
  const target = twoWay.find((repo) => repo.id === repositoryId);

  const submit = async () => {
    if (!target) return;
    try {
      await create.mutateAsync({ repositoryId: target.id });
      toast.success(fill(te.created, { provider: tm.provider[target.provider] }));
    } catch {
      toast.error(te.createFailed);
    }
  };

  if (repositories.isLoading) return null;
  if (twoWay.length === 0) return <p className="text-sm text-muted-foreground">{te.noRepositories}</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{te.createHint}</p>
      <Select value={repositoryId} onValueChange={setChosen}>
        <SelectTrigger className="w-full" aria-label={te.repository}>
          <SelectValue placeholder={te.selectRepository} />
        </SelectTrigger>
        <SelectContent>
          {twoWay.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" onClick={() => void submit()} disabled={!target || create.isPending}>
        {create.isPending && <Loader2 className="animate-spin" />}
        {create.isPending ? te.creating : te.create}
      </Button>
    </div>
  );
}

/**
 * The GitHub or GitLab issue this issue syncs with: its number, state and link,
 * and *Stop syncing*; or, when there is none, creating it on a repository that
 * has two-way issue sync turned on. Anyone who can read the issue sees the link;
 * changing it takes `merge_issues:update`.
 */
export function IssueExternalSync({ issue }: Readonly<{ issue: MergeIssueDetailDto }>) {
  const { t } = useI18n();
  const te = t.weldmerge.sync.externalSync;
  const canUpdate = useCan('merge_issues:update');

  if (!issue.external && !canUpdate) return null;

  return (
    <SectionCard title={te.title}>
      {issue.external ? <LinkedIssue external={issue.external} issueId={issue.id} /> : <CreateOnProvider issue={issue} />}
    </SectionCard>
  );
}
