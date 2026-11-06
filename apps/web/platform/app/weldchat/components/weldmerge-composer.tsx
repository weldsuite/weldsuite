import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitPullRequest, Loader2, SquareCheckBig } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { fill } from '@/app/weldmerge/lib/format';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useCommentOnMergePullRequest,
  useMergeShareSearch,
  type MergeShareResult,
} from '@/hooks/queries/use-weldmerge-across-queries';
import { useCreateMergeIssue, weldmergeKeys } from '@/hooks/queries/use-weldmerge-queries';
import { useAppAccess } from '@/hooks/use-app-access';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { cn } from '@/lib/utils';
import { cardPullRequestId, parseIssueCommand, parseMergeSearch, readWeldMergeCard } from '../lib/weldmerge-card';

/**
 * What the chat composer needs from WeldMerge: whether the slash commands
 * (`/merge`, `/issue`) are on, running `/issue`, and, in a thread under a
 * WeldMerge card for a pull request, the "Also post on the pull request" choice.
 */
export function useWeldMergeComposer({ channelId, parentId }: Readonly<{ channelId: string; parentId?: string }>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.chat;
  const { isInstalled, isLoading } = useAppAccess('weldmerge');
  const canRead = useCan('merge_issues:read');
  const canCreate = useCan('merge_issues:create');
  const canReview = useCan('merge_pull_requests:review');
  const enabled = !isLoading && isInstalled && canRead;

  const queryClient = useQueryClient();
  const { weldmerge } = useAppApi();
  const { getClient } = useAppApiClient();
  const createIssue = useCreateMergeIssue();
  const comment = useCommentOnMergePullRequest();
  const [alsoPost, setAlsoPost] = useState(false);

  // The thread's root message tells whether it is a pull request card.
  const root = useQuery({
    queryKey: [...weldmergeKeys.all, 'chat-thread-card', channelId, parentId ?? ''],
    enabled: enabled && canReview && !!parentId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: { metadata?: unknown } }>(`/chat-messages/${parentId}`);
    },
  });
  const pullRequestId = cardPullRequestId(readWeldMergeCard(root.data?.data?.metadata));

  /** Runs `/issue <title>`. True when the command was handled and the text can go. */
  const runIssueCommand = useCallback(
    async (text: string): Promise<boolean> => {
      if (!canCreate) {
        toast.error(tc.slash.issueCreateFailed);
        return false;
      }
      const teams = (
        await queryClient.fetchQuery({ queryKey: weldmergeKeys.teams(), queryFn: () => weldmerge.teams.list(), staleTime: 60_000 })
      ).data;
      const parsed = parseIssueCommand(text, teams.map((team) => team.key));
      if (!parsed) {
        toast.error(tc.slash.usageIssue);
        return false;
      }
      const team = (parsed.teamKey ? teams.find((candidate) => candidate.key.toUpperCase() === parsed.teamKey) : undefined) ?? teams[0];
      if (!team) {
        toast.error(tc.slash.issueNeedsTeam);
        return false;
      }
      try {
        const issue = await createIssue.mutateAsync({ teamId: team.id, title: parsed.title });
        toast.success(fill(tc.slash.issueCreated, { key: issue.key }), {
          description: issue.title,
          action: {
            label: tc.slash.viewIssue,
            onClick: () => {
              window.location.href = toPublicPath(`/weldmerge/issues/${issue.key}`);
            },
          },
        });
        return true;
      } catch {
        toast.error(tc.slash.issueCreateFailed);
        return false;
      }
    },
    [canCreate, createIssue, queryClient, tc.slash, weldmerge],
  );

  /**
   * Takes a typed WeldMerge slash command off the composer. `/issue <title>` creates the issue and
   * calls `onHandled` once it exists (the text can go); a typed `/merge <term>` that reaches here
   * found nothing to share, since results are picked from the picker. True when the text was one of
   * the two commands, so the caller does not post it.
   */
  const runSlashCommand = useCallback(
    (text: string, onHandled: () => void): boolean => {
      if (!enabled || !/^\/(issue|merge)(\s|$)/i.test(text)) return false;
      if (/^\/merge/i.test(text)) {
        const term = parseMergeSearch(text);
        toast.error(term ? fill(tc.slash.noResults, { query: term }) : tc.slash.usageMerge);
        return true;
      }
      void runIssueCommand(text).then((done) => {
        if (done) onHandled();
      });
      return true;
    },
    [enabled, runIssueCommand, tc.slash],
  );

  /** Posts a thread reply on the pull request too, when the choice is on; the reply itself is already sent. */
  const commentOnPullRequest = useCallback(
    (content: string) => {
      // An attachment-only reply has no text to post: skip it rather than fail.
      if (!alsoPost || !pullRequestId || content.trim() === '') return;
      comment.mutate(
        { id: pullRequestId, body: content },
        {
          onSuccess: () => toast.success(tc.commented),
          onError: () => toast.error(tc.commentFailed),
        },
      );
    },
    [alsoPost, pullRequestId, comment, tc.commented, tc.commentFailed],
  );

  return useMemo(() => ({
    enabled,
    /** The pull request this thread's card is about, when the member may comment on it. */
    threadPullRequestId: canReview ? pullRequestId : null,
    alsoPost,
    setAlsoPost,
    runIssueCommand,
    runSlashCommand,
    commentOnPullRequest,
  }), [enabled, canReview, pullRequestId, alsoPost, runIssueCommand, runSlashCommand, commentOnPullRequest]);
}

/** "Also post on the pull request", above the composer of a card's thread. */
export function MergeAlsoPostToggle({
  checked,
  onCheckedChange,
}: Readonly<{ checked: boolean; onCheckedChange: (checked: boolean) => void }>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.chat;
  return (
    <label className="flex items-center gap-2 px-3 pb-1 text-xs text-muted-foreground" title={tc.alsoPostHint}>
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} aria-label={tc.alsoPost} />
      <GitPullRequest className="size-3.5" aria-hidden />
      {tc.alsoPost}
    </label>
  );
}

/**
 * The results of `/merge <query>` above the composer: issues and open pull
 * requests. Arrow keys move, Enter or a click shares the highlighted one, Escape closes.
 */
export function MergeSharePicker({
  query,
  onPick,
  onDismiss,
}: Readonly<{ query: string; onPick: (result: MergeShareResult) => void; onDismiss: () => void }>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.chat;
  const ref = useRef<HTMLDivElement>(null);
  const debounced = useDebounce(query, 250);
  const search = useMergeShareSearch(debounced);
  const results = useMemo(() => (debounced === query && search.data ? search.data : []), [debounced, query, search.data]);
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [debounced]);

  // Capture phase on `document`, ahead of the composer's own handler, so Enter
  // shares the highlighted result instead of sending "/merge …" as a message.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const composer = ref.current?.closest('[data-chat-composer-root]');
      if (composer && event.target instanceof Node && !composer.contains(event.target)) return;
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (results.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => (index + 1) % results.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => (index - 1 + results.length) % results.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        const picked = results[Math.min(active, results.length - 1)];
        if (!picked) return;
        event.preventDefault();
        event.stopPropagation();
        onPick(picked);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [results, active, onPick, onDismiss]);

  let body;
  if (search.isFetching && results.length === 0) {
    body = (
      <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {fill(tc.slash.searchPlaceholder, { query })}
      </p>
    );
  } else if (search.isError) {
    body = <p className="px-3 py-2 text-sm text-destructive">{tc.slash.searchFailed}</p>;
  } else if (results.length === 0) {
    body = <p className="px-3 py-2 text-sm text-muted-foreground">{fill(tc.slash.noResults, { query })}</p>;
  } else {
    body = results.map((result, index) => (
      <button
        key={`${result.type}:${result.id}`}
        type="button"
        className={cn('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted', index === active && 'bg-muted')}
        onMouseEnter={() => setActive(index)}
        onMouseDown={(event) => {
          event.preventDefault();
          onPick(result);
        }}
      >
        {result.type === 'issue' ? (
          <SquareCheckBig className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{result.key}</span>
        <span className="min-w-0 flex-1 truncate">{result.title}</span>
      </button>
    ));
  }

  return (
    <div ref={ref} className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-60 overflow-y-auto rounded-lg border bg-popover shadow-lg">
      {body}
    </div>
  );
}
