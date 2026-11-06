import { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { useMergeIssues } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { IssueStatusIcon } from './primitives';

/**
 * Find an issue by key or title and hand it back; used to link a pull request
 * to an issue by hand. Issues in `excludeIds` (already linked) are left out.
 */
export function LinkIssuePopover({
  excludeIds,
  pending,
  onPick,
}: Readonly<{ excludeIds: readonly string[]; pending: boolean; onPick: (issueId: string) => void }>) {
  const { t } = useI18n();
  const tp = t.weldmerge.pullRequests;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim(), 250) || undefined;
  const issues = useMergeIssues({ q }, open);
  const results = (issues.data ?? []).filter((issue) => !excludeIds.includes(issue.id)).slice(0, 8);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Link2 />}
          {tp.linkIssue}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 p-2">
        <Input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tp.linkIssueSearch}
          aria-label={tp.linkIssueSearch}
        />
        <ul className="max-h-64 overflow-y-auto">
          {issues.isLoading && (
            <li className="flex justify-center p-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </li>
          )}
          {!issues.isLoading && results.length === 0 && (
            <li className="p-3 text-center text-sm text-muted-foreground">{tp.linkIssueEmpty}</li>
          )}
          {results.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  onPick(issue.id);
                }}
              >
                <IssueStatusIcon status={issue.status} />
                <span className="shrink-0 text-xs text-muted-foreground">{issue.key}</span>
                <span className="truncate">{issue.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
