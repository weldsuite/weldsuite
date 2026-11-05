import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, MoreVertical, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { BoardElement } from '@weldsuite/board-engine';
import type { RecordCommentMessage } from '@weldsuite/app-api-client';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { RecordChatPanelBar } from '@/app/weldchat/components/record-chat-panel-bar';
import { CommentBody, CommentComposer, initials, type ComposerLabels, type Person } from '@/components/record-comments/comment-parts';
import { fromChatContent } from '@/components/record-comments/mentions';
import { useRecordComments, type RecordCommentsState } from '@/components/record-comments/use-record-comments';
import type { BoardController } from '../editor/model/board-controller';
import type { BoardPanels } from './panels';

/** A pin's thread id (a pin made before threads had their own id uses its own). */
const threadOf = (pin: BoardElement) => pin.thread ?? pin.id;

/** What a pin is on, in a few words: its element's text, else its type. */
function pinLabel(c: BoardController, pin: BoardElement, fallback: string): string {
  const target = pin.target ? c.board.get(pin.target) : undefined;
  const text = target?.text?.text ?? target?.title ?? target?.name ?? target?.fileName ?? '';
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return short || fallback;
}

/**
 * The comments beside the board: every comment pin's thread, newest first,
 * open ones unless "show resolved" is on. What is said is a thread in the
 * board's WeldChat chat (ADR CHAT-007), so comments show in WeldChat too and
 * @mentions notify from there; the board keeps only the pins.
 */
export function CommentsPanel({ controller: c, boardId, people, panels }: { controller: BoardController; boardId: string; people: Person[]; panels: BoardPanels }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const state = useSyncExternalStore(panels.subscribe, panels.get);
  const { t } = useI18n();
  const tc = t.weldboard.editor.comments;
  const [showResolved, setShowResolved] = useState(false);
  const pins = [...c.board.elements.values()].filter((e) => e.type === 'comment').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const comments = useRecordComments('board', boardId, pins.map(threadOf));
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const mayComment = !c.readOnly || c.canComment;
  const shown = pins.filter((p) => showResolved || !p.resolved || p.id === state.activeComment);

  // A pin just placed has no message yet: when its first comment is dropped, the pin goes too.
  const dropEmptyPin = (pin: BoardElement) => {
    if (!comments.threads.get(threadOf(pin))?.messages.length && pin.createdBy === c.options.userId) c.apply({ type: 'delete', ids: [pin.id] }, { comment: true });
  };

  return (
    <aside className="pointer-events-auto flex max-h-full w-80 flex-col rounded-xl border bg-background shadow-lg" aria-label={tc.title}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{tc.title}</h2>
        <Button size="icon" variant="ghost" className="size-7" aria-label={tc.close} onClick={() => panels.close()}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <RecordChatPanelBar entityType="board" entityId={boardId} channelId={comments.channelId} />
        <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          {tc.showResolved}
        </label>
        {comments.isError && <p className="px-1 text-sm text-destructive">{tc.loadFailed}</p>}
        {shown.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{tc.empty}</p>}
        {shown.map((pin) => (
          <ThreadCard
            key={pin.id}
            controller={c}
            pin={pin}
            label={pinLabel(c, pin, tc.onBoard)}
            people={people}
            names={names}
            comments={comments}
            mayComment={mayComment}
            active={state.activeComment === pin.id}
            onPick={() => {
              panels.focusComment(pin.id);
              c.select([pin.id]);
              c.showRect({ x: pin.x - 200, y: pin.y - 150, w: 400, h: 300 }, { maxZoom: 1.25 });
            }}
            onAbandon={() => dropEmptyPin(pin)}
          />
        ))}
      </div>
    </aside>
  );
}

function ThreadCard({
  controller: c,
  pin,
  label,
  people,
  names,
  comments,
  mayComment,
  active,
  onPick,
  onAbandon,
}: {
  controller: BoardController;
  pin: BoardElement;
  label: string;
  people: Person[];
  names: ReadonlyMap<string, string>;
  comments: RecordCommentsState;
  mayComment: boolean;
  active: boolean;
  onPick: () => void;
  onAbandon: () => void;
}) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.comments;
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  const me = c.options.userId;
  const thread = threadOf(pin);
  const messages = comments.threads.get(thread)?.messages ?? [];
  const fresh = messages.length === 0 && !comments.isLoading && pin.createdBy === me;
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // A thread goes as a whole only while nobody else has said anything in it.
  const deletable = pin.createdBy === me && messages.every((m) => m.authorId === me);
  const deleteThread = async () => {
    try {
      await comments.remove(messages.map((m) => m.id));
    } catch {
      toast.error(tc.failed);
      return;
    }
    c.apply({ type: 'delete', ids: [pin.id] }, { comment: true });
  };
  const labels: ComposerLabels = { placeholder: messages.length ? tc.replyPlaceholder : tc.placeholder, submit: messages.length ? tc.reply : tc.send, cancel: tc.cancel, noMatch: tc.noMatch };

  return (
    <div ref={ref} className={`flex flex-col gap-2 rounded-lg border bg-card p-3 ${active ? 'ring-2 ring-primary/50' : ''} ${pin.resolved ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" onClick={onPick} title={tc.goTo} className="min-w-0 flex-1 truncate text-left hover:text-foreground hover:underline">
          {label}
        </button>
        {mayComment && messages.length > 0 && (
          <button
            type="button"
            title={pin.resolved ? tc.reopen : tc.resolve}
            aria-label={pin.resolved ? tc.reopen : tc.resolve}
            className="rounded p-1 hover:bg-accent [&_svg]:size-3.5"
            onClick={() => c.apply({ type: 'set', id: pin.id, patch: { resolved: !pin.resolved } }, { comment: true })}
          >
            {pin.resolved ? <RotateCcw /> : <Check />}
          </button>
        )}
      </div>
      {messages.length === 0 && !fresh && <p className="text-xs italic text-muted-foreground">{comments.isLoading ? tc.loading : tc.missing}</p>}
      {messages.map((m, i) => (
        <CommentEntry
          key={m.id}
          message={m}
          people={people}
          names={names}
          own={m.authorId === me && mayComment}
          deleteLabel={i === 0 ? tc.deleteThread : tc.delete}
          onDelete={i === 0 ? (deletable ? () => void deleteThread() : undefined) : () => void comments.remove([m.id]).catch(() => toast.error(tc.failed))}
          onEdit={(body) =>
            comments.edit(m.id, body).catch((err) => {
              toast.error(tc.failed);
              throw err;
            })
          }
        />
      ))}
      {mayComment &&
        !pin.resolved &&
        (replying || active || fresh ? (
          <CommentComposer
            people={people}
            labels={labels}
            autoFocus={fresh || active}
            onSubmit={async (body) => {
              try {
                await comments.reply({ id: thread, label }, body);
              } catch (err) {
                toast.error(tc.failed);
                throw err;
              }
              setReplying(false);
            }}
            onCancel={() => {
              setReplying(false);
              if (fresh) onAbandon();
            }}
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
  const tc = t.weldboard.editor.comments;
  const [editing, setEditing] = useState(false);
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.createdAt));
  const labels: ComposerLabels = { placeholder: tc.placeholder, submit: tc.save, cancel: tc.cancel, noMatch: tc.noMatch };
  return (
    <div className="flex gap-2">
      <Avatar className="mt-0.5 size-6 shrink-0" aria-hidden>
        <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">{initials(message.authorName)}</AvatarFallback>
      </Avatar>
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
