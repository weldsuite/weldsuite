import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, MessageSquarePlus, MoreVertical, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { formatA1 } from '@weldsuite/sheets-engine';
import type { RecordCommentMessage } from '@weldsuite/app-api-client';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { RecordChatPanelBar } from '@/app/weldchat/components/record-chat-panel-bar';
import { CommentBody, CommentComposer, initials, type ComposerLabels, type Person } from '@/components/record-comments/comment-parts';
import { fromChatContent } from '@/components/record-comments/mentions';
import { useRecordComments, type RecordCommentsState } from '@/components/record-comments/use-record-comments';
import { addThread, newCommentId, removeThread, setResolved, threadsOf, type Thread } from '../model/comments';
import type { SheetController } from '../model/sheet-controller';
import { RulePanel } from '../rules/panel';

export type { Person };

type Filter = 'open' | 'resolved' | 'all';

/**
 * The comments beside the grid, as in Google Sheets: a box for a new comment
 * on the selected cell, then every thread of the workbook (open ones first by
 * default), each with its replies. Picking a thread goes to its cell.
 *
 * The workbook says where each thread is and whether it is resolved; what is
 * said in it is a thread in the sheet's WeldChat chat (ADR CHAT-007), so a
 * comment also shows in WeldChat, and @mentions notify from there.
 */
export function CommentsPanel({ controller, sheetId, people }: { controller: SheetController; sheetId: string; people: Person[] }) {
  const { t } = useI18n();
  const tc = t.weldsheets.comments;
  const [filter, setFilter] = useState<Filter>('open');
  const [composing, setComposing] = useState(false);
  const { row, col } = controller.selection.active;
  // Asked for from the grid (Ctrl+Alt+M, the menu): the box opens here.
  const requested = controller.commentRequested;
  useEffect(() => {
    if (!requested) return;
    controller.commentRequested = false;
    setComposing(true);
  }, [controller, requested]);
  const sheet = controller.sheet;
  const authorId = controller.options.author?.id ?? '';

  const threads = controller.engine.workbook.sheets.flatMap((tab) => threadsOf(tab).map((thread) => ({ thread, tabName: tab.name })));
  const comments = useRecordComments(
    'sheet',
    sheetId,
    threads.map(({ thread }) => thread.comment.id),
  );
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const shown = threads.filter(({ thread }) => filter === 'all' || (filter === 'resolved') === !!thread.comment.resolved);
  const here = (thread: Thread) => thread.tabId === sheet.id && thread.comment.cell?.row === row && thread.comment.cell.col === col;
  const focused = controller.focusedThread;
  const labels: ComposerLabels = { placeholder: tc.placeholder, submit: tc.comment, cancel: tc.cancel, noMatch: tc.noMatch };

  const startThread = async (body: string) => {
    // Where the box was opened, whatever is selected by the time the comment is posted.
    const at = { tabId: sheet.id, cell: { row, col }, label: `${sheet.name}!${formatA1(row, col)}` };
    const id = newCommentId();
    try {
      await comments.start({ id, label: at.label }, body);
    } catch (err) {
      toast.error(tc.failed);
      throw err;
    }
    addThread(controller, id, at.cell, authorId, at.tabId);
    controller.focusedThread = id;
    setComposing(false);
    setFilter((f) => (f === 'resolved' ? 'open' : f));
  };

  return (
    <RulePanel title={tc.title} closeLabel={tc.close} onClose={() => controller.openPanel(null)}>
      <div className="-mx-1 -mt-1">
        <RecordChatPanelBar entityType="sheet" entityId={sheetId} channelId={comments.channelId} />
      </div>
      <div className="flex items-center gap-1 text-xs">
        {(['open', 'resolved', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2 py-1 ${filter === f ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'}`}
          >
            {tc.filters[f]}
          </button>
        ))}
      </div>
      {controller.mayComment &&
        (composing ? (
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 text-xs text-muted-foreground">{tc.on.replace('{cell}', `${sheet.name}!${formatA1(row, col)}`)}</div>
            <CommentComposer people={people} labels={labels} autoFocus onSubmit={startThread} onCancel={() => setComposing(false)} />
          </div>
        ) : (
          <Button size="sm" variant="outline" className="gap-1.5 self-start" onClick={() => setComposing(true)}>
            <MessageSquarePlus className="size-4" />
            {tc.add.replace('{cell}', formatA1(row, col))}
          </Button>
        ))}
      {comments.isError && <p className="text-sm text-destructive">{tc.loadFailed}</p>}
      {shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{filter === 'resolved' ? tc.noneResolved : tc.none}</p>}
      {shown.map(({ thread, tabName }) => (
        <ThreadCard
          key={thread.comment.id}
          controller={controller}
          thread={thread}
          tabName={tabName}
          people={people}
          names={names}
          comments={comments}
          active={here(thread) || focused === thread.comment.id}
          onPick={() => {
            controller.focusedThread = thread.comment.id;
            if (thread.comment.cell) controller.goTo(thread.tabId, thread.comment.cell.row, thread.comment.cell.col);
          }}
        />
      ))}
    </RulePanel>
  );
}

function ThreadCard({
  controller,
  thread,
  tabName,
  people,
  names,
  comments,
  active,
  onPick,
}: {
  controller: SheetController;
  thread: Thread;
  tabName: string;
  people: Person[];
  names: ReadonlyMap<string, string>;
  comments: RecordCommentsState;
  active: boolean;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const tc = t.weldsheets.comments;
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  const { comment } = thread;
  const me = controller.options.author?.id ?? '';
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const cell = comment.cell ? `${tabName}!${formatA1(comment.cell.row, comment.cell.col)}` : tc.cellDeleted;
  const messages = comments.threads.get(comment.id)?.messages ?? [];
  // A thread goes as a whole only while nobody else has said anything in it.
  const deletable = comment.authorId === me && messages.every((m) => m.authorId === me);
  const labels: ComposerLabels = { placeholder: tc.replyPlaceholder, submit: tc.reply, cancel: tc.cancel, noMatch: tc.noMatch };

  const deleteThread = async () => {
    try {
      await comments.remove(messages.map((m) => m.id));
    } catch {
      toast.error(tc.failed);
      return;
    }
    removeThread(controller, thread);
  };
  /** A reply goes alone; the first comment goes with its thread, when it may. */
  const onDeleteOf = (m: RecordCommentMessage, first: boolean) => {
    if (!first) return () => void comments.remove([m.id]).catch(() => toast.error(tc.failed));
    return deletable ? deleteThread : undefined;
  };

  return (
    <div ref={ref} className={`flex flex-col gap-2 rounded-lg border bg-card p-3 ${active ? 'ring-2 ring-primary/50' : ''} ${comment.resolved ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" onClick={onPick} disabled={!comment.cell} title={tc.goToCell} className="min-w-0 flex-1 truncate text-left font-mono hover:text-foreground hover:underline disabled:no-underline">
          {cell}
        </button>
        {controller.mayComment && (
          <button
            type="button"
            title={comment.resolved ? tc.reopen : tc.resolve}
            aria-label={comment.resolved ? tc.reopen : tc.resolve}
            className="rounded p-1 hover:bg-accent [&_svg]:size-3.5"
            onClick={() => setResolved(controller, thread, !comment.resolved)}
          >
            {comment.resolved ? <RotateCcw /> : <Check />}
          </button>
        )}
      </div>
      {messages.length === 0 && <p className="text-xs italic text-muted-foreground">{comments.isLoading ? tc.loading : tc.missing}</p>}
      {messages.map((m, i) => (
        <CommentEntry
          key={m.id}
          message={m}
          people={people}
          names={names}
          own={m.authorId === me && controller.mayComment}
          deleteLabel={i === 0 ? tc.deleteThread : tc.delete}
          onDelete={onDeleteOf(m, i === 0)}
          onEdit={(body) => comments.edit(m.id, body).catch((err) => {
            toast.error(tc.failed);
            throw err;
          })}
        />
      ))}
      {controller.mayComment &&
        !comment.resolved &&
        (replying || active ? (
          <CommentComposer
            people={people}
            labels={labels}
            onSubmit={async (body) => {
              try {
                await comments.reply({ id: comment.id, label: cell }, body);
              } catch (err) {
                toast.error(tc.failed);
                throw err;
              }
              setReplying(false);
            }}
            onCancel={replying ? () => setReplying(false) : undefined}
          />
        ) : (
          <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => setReplying(true)}>
            {tc.reply}
          </button>
        ))}
    </div>
  );
}

function CommentEntry({
  message,
  people,
  names,
  own,
  deleteLabel,
  onDelete,
  onEdit,
}: {
  message: RecordCommentMessage;
  people: Person[];
  names: ReadonlyMap<string, string>;
  own: boolean;
  deleteLabel: string;
  onDelete?: () => void;
  onEdit: (body: string) => Promise<unknown>;
}) {
  const { t, language } = useI18n();
  const tc = t.weldsheets.comments;
  const [editing, setEditing] = useState(false);
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.createdAt));
  const labels: ComposerLabels = { placeholder: tc.placeholder, submit: tc.save, cancel: tc.cancel, noMatch: tc.noMatch };
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary" aria-hidden>
        {initials(message.authorName)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{message.authorName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {when}
            {message.isEdited ? ` · ${tc.edited}` : ''}
          </span>
          {own && !editing && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={tc.actions} className="ml-auto rounded p-0.5 hover:bg-accent [&_svg]:size-3.5">
                  <MoreVertical />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}>{tc.edit}</DropdownMenuItem>
                {onDelete && <DropdownMenuItem onSelect={onDelete}>{deleteLabel}</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <CommentComposer
              people={people}
              labels={labels}
              initial={fromChatContent(message.content)}
              autoFocus
              onSubmit={async (body) => {
                await onEdit(body);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <CommentBody content={message.content} names={names} />
        )}
      </div>
    </div>
  );
}
