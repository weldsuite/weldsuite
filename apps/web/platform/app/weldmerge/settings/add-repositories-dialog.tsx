import { useEffect, useMemo, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import type { MergeTeamDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useAddMergeRepository, useMergeAvailableRepositories } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../lib/format';

const NO_TEAM = '__none__';

/**
 * Pick repositories of a connection to follow: a team for the batch and whether
 * to sync their pull requests. Each one is added (and its open and recently
 * merged pull requests loaded) in turn.
 */
export function AddRepositoriesDialog({
  open,
  onOpenChange,
  connectionId,
  teams,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string | undefined;
  teams: readonly MergeTeamDto[];
}>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const ta = tm.settings.addRepositories;
  const available = useMergeAvailableRepositories(connectionId, open);
  const add = useAddMergeRepository();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [teamId, setTeamId] = useState(NO_TEAM);
  const [prSync, setPrSync] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelected([]);
      setTeamId(NO_TEAM);
      setPrSync(true);
    }
  }, [open]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (available.data ?? []).filter((repo) => !term || repo.fullName.toLowerCase().includes(term));
  }, [available.data, search]);

  const toggle = (externalId: string) =>
    setSelected((current) => (current.includes(externalId) ? current.filter((id) => id !== externalId) : [...current, externalId]));

  const submit = async () => {
    if (!connectionId || selected.length === 0) return;
    setBusy(true);
    let added = 0;
    try {
      for (const externalId of selected) {
        await add.mutateAsync({
          connectionId,
          externalId,
          teamId: teamId === NO_TEAM ? null : teamId,
          prSync,
        });
        added += 1;
      }
      toast.success(fill(ta.added, { count: added }));
      onOpenChange(false);
    } catch {
      if (added > 0) toast.success(fill(ta.added, { count: added }));
      toast.error(ta.addFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ta.title}</DialogTitle>
          <DialogDescription>{ta.description}</DialogDescription>
        </DialogHeader>

        {!connectionId ? (
          <p className="text-sm text-muted-foreground">{ta.connectFirst}</p>
        ) : available.isLoading ? (
          <PageLoader fullScreen={false} className="min-h-40" />
        ) : available.isError ? (
          <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void available.refetch()} />
        ) : (
          <div className="space-y-4">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={ta.search}
              aria-label={ta.search}
            />
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
              {rows.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">{ta.empty}</li>}
              {rows.map((repo) => (
                <li key={repo.externalId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={repo.added || selected.includes(repo.externalId)}
                      disabled={repo.added}
                      onCheckedChange={() => toggle(repo.externalId)}
                    />
                    <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                    {repo.private && <Lock className="size-3.5 text-muted-foreground" aria-label={ta.private} />}
                    {repo.added && <span className="text-xs text-muted-foreground">{ta.alreadyAdded}</span>}
                  </label>
                </li>
              ))}
            </ul>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{ta.team}</Label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEAM}>{tm.settings.repositories.noTeam}</SelectItem>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name} ({team.key})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch id="merge-add-pr-sync" checked={prSync} onCheckedChange={setPrSync} />
                <Label htmlFor="merge-add-pr-sync">{ta.prSync}</Label>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || selected.length === 0}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? ta.adding : ta.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
