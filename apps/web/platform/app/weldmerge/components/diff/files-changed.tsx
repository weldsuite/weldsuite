import { useEffect, useMemo, useState } from 'react';
import { FileDiff as FileIcon } from 'lucide-react';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import type { MergePullRequestFile, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { cn } from '@weldsuite/ui/lib/utils';
import { useMergePullRequestFiles, useMergePullRequestThreads } from '@/hooks/queries/use-weldmerge-review-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../../lib/format';
import { splitPath } from '../../lib/diff';
import { FileDiff, type DraftComment } from './file-diff';

interface FilesChangedProps {
  pullRequestId: string;
  canReview: boolean;
  drafts: DraftComment[];
  onAddDraft: (draft: Omit<DraftComment, 'id'>) => void;
  onCommentNow: (draft: Omit<DraftComment, 'id'>) => Promise<void>;
  onRemoveDraft: (id: string) => void;
  onReply: (thread: MergeReviewThread, body: string) => Promise<void>;
}

const STATUS_LETTER: Record<MergePullRequestFile['status'], { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600' },
  removed: { letter: 'D', className: 'text-red-500' },
  modified: { letter: 'M', className: 'text-amber-600' },
  renamed: { letter: 'R', className: 'text-sky-600' },
  copied: { letter: 'C', className: 'text-sky-600' },
  changed: { letter: 'M', className: 'text-amber-600' },
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

/** The Files changed tab: a file list with status and counts next to every file's diff. */
export function FilesChanged({ pullRequestId, canReview, drafts, onAddDraft, onCommentNow, onRemoveDraft, onReply }: Readonly<FilesChangedProps>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tf = tm.reviewing.files;
  const files = useMergePullRequestFiles(pullRequestId);
  const threads = useMergePullRequestThreads(pullRequestId);
  const [filter, setFilter] = useState('');
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (files.data ?? []).filter((file) => term === '' || file.path.toLowerCase().includes(term));
  }, [files.data, filter]);

  const threadsByPath = useMemo(() => {
    const map = new Map<string, MergeReviewThread[]>();
    for (const thread of threads.data ?? []) {
      if (thread.path) map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);
    }
    return map;
  }, [threads.data]);

  const goTo = (path: string) => {
    setActive(path);
    document.getElementById(`file-${path}`)?.scrollIntoView?.({ block: 'start' });
  };

  // j / k: next and previous file.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      const index = visible.findIndex((file) => file.path === active);
      const next = event.key === 'j' ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0);
      const target = visible[index === -1 ? 0 : next];
      if (target) goTo(target.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (files.isLoading) return <PageLoader fullScreen={false} />;
  if (files.isError || !files.data) {
    return <ErrorState message={tf.loadFailed} retryLabel={tm.retry} onRetry={() => void files.refetch()} />;
  }
  if (files.data.length === 0) return <EmptyState icon={FileIcon} title={tf.empty} description={tf.emptyDescription} />;

  const setFileViewed = (path: string, value: boolean) =>
    setViewed((current) => {
      const next = new Set(current);
      if (value) next.add(path);
      else next.delete(path);
      return next;
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label={tf.heading} className="space-y-2 lg:sticky lg:top-2 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={tf.searchPlaceholder} aria-label={tf.searchPlaceholder} />
        <p className="text-xs text-muted-foreground">
          {fill(tf.viewedProgress, { viewed: viewed.size, total: files.data.length })} · {tf.keyboardHint}
        </p>
        {visible.length === 0 && <p className="text-sm text-muted-foreground">{tf.noMatches}</p>}
        <ul className="space-y-0.5">
          {visible.map((file) => {
            const status = STATUS_LETTER[file.status];
            const { name } = splitPath(file.path);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => goTo(file.path)}
                  title={file.path}
                  aria-current={active === file.path ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent',
                    active === file.path && 'bg-accent',
                    viewed.has(file.path) && 'text-muted-foreground',
                  )}
                >
                  <span className={cn('w-3 shrink-0 font-mono font-semibold', status.className)} title={tf.status[file.status]}>
                    {status.letter}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="text-emerald-600">+{file.additions}</span> <span className="text-red-500">−{file.deletions}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 space-y-4">
        {visible.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            viewed={viewed.has(file.path)}
            onViewedChange={(value) => setFileViewed(file.path, value)}
            threads={threadsByPath.get(file.path) ?? []}
            drafts={drafts.filter((draft) => draft.path === file.path)}
            canReview={canReview}
            onAddDraft={onAddDraft}
            onCommentNow={onCommentNow}
            onRemoveDraft={onRemoveDraft}
            onReply={onReply}
          />
        ))}
      </div>
    </div>
  );
}
