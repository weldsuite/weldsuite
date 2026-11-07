import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergePullRequestFile, MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { anchorKey, commentAnchor, lineCount, parsePatch, splitPath, type DiffSide } from '../../lib/diff';
import { fill } from '../../lib/format';
import { ThreadCard } from '../review/thread-card';

/** A line comment written but not yet sent; it goes out with the review. */
export interface DraftComment {
  id: string;
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

/** Diffs longer than this start collapsed. */
export const LARGE_DIFF_LINES = 400;

interface Selection {
  side: DiffSide;
  from: number;
  to: number;
}

interface FileDiffProps {
  file: MergePullRequestFile;
  viewed: boolean;
  onViewedChange: (viewed: boolean) => void;
  threads: MergeReviewThread[];
  drafts: DraftComment[];
  canReview: boolean;
  onAddDraft: (draft: Omit<DraftComment, 'id'>) => void;
  onCommentNow: (draft: Omit<DraftComment, 'id'>) => Promise<void>;
  onRemoveDraft: (id: string) => void;
  onReply: (thread: MergeReviewThread, body: string) => Promise<void>;
}

const STATUS_TONE = {
  added: 'success',
  removed: 'danger',
  modified: 'neutral',
  renamed: 'warning',
  copied: 'warning',
  changed: 'neutral',
} as const;

const LINE_MARK = { add: '+', del: '−', context: ' ', meta: ' ' } as const;

const LINE_BG = {
  add: 'bg-emerald-500/10',
  del: 'bg-red-500/10',
  context: '',
  meta: 'text-muted-foreground italic',
} as const;

/** One file's unified diff with line numbers on both sides, inline threads, and a composer for a selected line or range. */
export function FileDiff({
  file,
  viewed,
  onViewedChange,
  threads,
  drafts,
  canReview,
  onAddDraft,
  onCommentNow,
  onRemoveDraft,
  onReply,
}: Readonly<FileDiffProps>) {
  const { t } = useI18n();
  const tf = t.weldmerge.reviewing.files;
  const td = t.weldmerge.reviewing.draft;
  const hunks = useMemo(() => parsePatch(file.patch), [file.patch]);
  const total = lineCount(hunks);
  const large = total > LARGE_DIFF_LINES;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? !(viewed || large);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const threadsByAnchor = useMemo(() => {
    const map = new Map<string, MergeReviewThread[]>();
    for (const thread of threads) {
      if (thread.line === null || thread.side === null) continue;
      const key = anchorKey(file.path, thread.side, thread.line);
      map.set(key, [...(map.get(key) ?? []), thread]);
    }
    return map;
  }, [threads, file.path]);

  const draftsByAnchor = useMemo(() => {
    const map = new Map<string, DraftComment[]>();
    for (const draft of drafts) {
      const key = anchorKey(draft.path, draft.side, draft.line);
      map.set(key, [...(map.get(key) ?? []), draft]);
    }
    return map;
  }, [drafts]);

  const { dir, name } = splitPath(file.path);

  const select = (side: DiffSide, line: number, extend: boolean) => {
    setText('');
    setSelection((current) =>
      extend && current && current.side === side
        ? { side, from: Math.min(current.from, line), to: Math.max(current.from, line) }
        : { side, from: line, to: line },
    );
  };

  const submit = async (now: boolean) => {
    if (!selection || text.trim() === '') return;
    // The contract anchors a comment on one line: a range comments on its last line.
    const draft = { path: file.path, line: selection.to, side: selection.side, body: text.trim() };
    if (!now) {
      onAddDraft(draft);
      setSelection(null);
      setText('');
      return;
    }
    setSending(true);
    try {
      await onCommentNow(draft);
      setSelection(null);
      setText('');
    } catch {
      // The page reports the failure; the text stays.
    } finally {
      setSending(false);
    }
  };

  const composer = selection && (
    <div className="space-y-2 border-y bg-card p-3 font-sans">
      <p className="text-xs font-medium">
        {selection.from === selection.to
          ? fill(td.title, { path: file.path, line: selection.to })
          : fill(td.titleRange, { path: file.path, from: selection.from, to: selection.to })}
      </p>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={td.placeholder}
        aria-label={td.placeholder}
        rows={3}
        autoFocus
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSelection(null)}>
          {td.cancel}
        </Button>
        <Button variant="outline" size="sm" disabled={text.trim() === '' || sending} onClick={() => void submit(true)}>
          {td.commentNow}
        </Button>
        <Button size="sm" disabled={text.trim() === ''} onClick={() => void submit(false)}>
          {td.addToReview}
        </Button>
      </div>
    </div>
  );

  return (
    <section id={`file-${file.path}`} className="scroll-mt-4 overflow-hidden rounded-lg border" aria-label={file.path}>
      <header className="flex flex-wrap items-center gap-2 bg-muted/40 px-3 py-2 text-sm">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-expanded={open}
          aria-label={open ? tf.collapse : tf.expand}
          onClick={() => setExpanded(!open)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-semibold">{name}</span>
          {file.previousPath && (
            <span className="ml-2 text-muted-foreground">{fill(tf.renamedFrom, { path: file.previousPath })}</span>
          )}
        </span>
        <SoftBadge tone={STATUS_TONE[file.status]}>{tf.status[file.status]}</SoftBadge>
        <span className="text-xs tabular-nums">
          <span className="text-emerald-600">+{file.additions}</span> <span className="text-red-500">−{file.deletions}</span>
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox
            checked={viewed}
            onCheckedChange={(value) => {
              onViewedChange(value === true);
              // Marking a file viewed folds it away, like on the provider.
              setExpanded(value === true ? false : true);
            }}
          />
          {tf.viewed}
        </label>
      </header>

      {open && file.patch === null && <p className="px-4 py-6 text-sm text-muted-foreground">{tf.noPatch}</p>}

      {open && file.patch !== null && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {hunks.map((hunk) => (
                <Fragment key={hunk.header}>
                  <tr className="bg-sky-500/10 text-muted-foreground">
                    <td colSpan={4} className="px-3 py-1">
                      {hunk.header}
                    </td>
                  </tr>
                  {hunk.lines.map((line, index) => {
                    const anchor = commentAnchor(line);
                    const key = anchor ? anchorKey(file.path, anchor.side, anchor.line) : null;
                    const inSelection =
                      !!anchor && !!selection && anchor.side === selection.side && anchor.line >= selection.from && anchor.line <= selection.to;
                    const isSelectionEnd = inSelection && anchor.line === selection.to;
                    const lineThreads = key ? (threadsByAnchor.get(key) ?? []) : [];
                    const lineDrafts = key ? (draftsByAnchor.get(key) ?? []) : [];
                    return (
                      <Fragment key={`${hunk.header}:${index}`}>
                        <tr className={cn(LINE_BG[line.kind], inSelection && 'outline outline-1 -outline-offset-1 outline-primary/60')}>
                          <td className="w-12 select-none px-2 text-right text-muted-foreground tabular-nums">{line.oldNumber}</td>
                          <td className="w-12 select-none px-2 text-right text-muted-foreground tabular-nums">{line.newNumber}</td>
                          <td className="w-7 p-0 text-center">
                            {anchor && canReview && (
                              <button
                                type="button"
                                className="size-5 rounded text-muted-foreground opacity-40 hover:bg-primary hover:text-primary-foreground hover:opacity-100 focus-visible:opacity-100"
                                aria-label={tf.addComment}
                                onClick={(event) => select(anchor.side, anchor.line, event.shiftKey)}
                              >
                                <Plus className="mx-auto size-3.5" />
                              </button>
                            )}
                          </td>
                          <td className="whitespace-pre px-2">
                            <span className="select-none text-muted-foreground">
                              {LINE_MARK[line.kind]}
                            </span>
                            {line.text}
                          </td>
                        </tr>
                        {(lineThreads.length > 0 || lineDrafts.length > 0 || isSelectionEnd) && (
                          <tr>
                            <td colSpan={4} className="space-y-2 bg-background p-2 font-sans">
                              {lineThreads.map((thread) => (
                                <ThreadCard key={thread.id} thread={thread} canReply={canReview} onReply={onReply} />
                              ))}
                              {lineDrafts.map((draft) => (
                                <div key={draft.id} className="rounded-lg border border-dashed bg-card p-3 text-sm">
                                  <div className="mb-1 flex items-center gap-2">
                                    <SoftBadge tone="warning">{td.pending}</SoftBadge>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="ml-auto size-7"
                                      aria-label={td.remove}
                                      onClick={() => onRemoveDraft(draft.id)}
                                    >
                                      <Trash2 />
                                    </Button>
                                  </div>
                                  <p className="whitespace-pre-wrap">{draft.body}</p>
                                </div>
                              ))}
                              {isSelectionEnd && composer}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!open && large && !viewed && (
        <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
          {fill(tf.largeDiff, { count: total })}
          <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
            {tf.showDiff}
          </Button>
        </div>
      )}
    </section>
  );
}
