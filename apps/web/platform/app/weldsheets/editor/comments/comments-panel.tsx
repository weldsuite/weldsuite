import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, MessageSquarePlus, MoreVertical, RotateCcw } from 'lucide-react';
import { formatA1, type SheetComment } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { addThread, editComment, removeComment, reply, setResolved, threadsOf, type CommentAuthor, type Thread } from '../model/comments';
import type { SheetController } from '../model/sheet-controller';
import { RulePanel } from '../rules/panel';

/** Someone who can be mentioned. */
export interface Person {
  id: string;
  name: string;
}

type Filter = 'open' | 'resolved' | 'all';

/**
 * The comments beside the grid, as in Google Sheets: a box for a new comment
 * on the selected cell, then every thread of the workbook (open ones first by
 * default), each with its replies. Picking a thread goes to its cell.
 */
export function CommentsPanel({ controller, people, author }: { controller: SheetController; people: Person[]; author: CommentAuthor }) {
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

  const threads = controller.engine.workbook.sheets.flatMap((tab) => threadsOf(tab).map((thread) => ({ thread, tabName: tab.name })));
  const shown = threads.filter(({ thread }) => filter === 'all' || (filter === 'resolved') === !!thread.root.resolved);
  const here = (thread: Thread) => thread.tabId === sheet.id && thread.root.cell?.row === row && thread.root.cell.col === col;
  const focused = controller.focusedThread;

  return (
    <RulePanel title={tc.title} closeLabel={tc.close} onClose={() => controller.openPanel(null)}>
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
            <Composer
              people={people}
              placeholder={tc.placeholder}
              submitLabel={tc.comment}
              autoFocus
              onSubmit={(body) => {
                const root = addThread(controller, { row, col }, body, author);
                controller.focusedThread = root.id;
                setComposing(false);
                setFilter((f) => (f === 'resolved' ? 'open' : f));
              }}
              onCancel={() => setComposing(false)}
            />
          </div>
        ) : (
          <Button size="sm" variant="outline" className="gap-1.5 self-start" onClick={() => setComposing(true)}>
            <MessageSquarePlus className="size-4" />
            {tc.add.replace('{cell}', formatA1(row, col))}
          </Button>
        ))}
      {shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{filter === 'resolved' ? tc.noneResolved : tc.none}</p>}
      {shown.map(({ thread, tabName }) => (
        <ThreadCard
          key={thread.root.id}
          controller={controller}
          thread={thread}
          tabName={tabName}
          people={people}
          author={author}
          active={here(thread) || focused === thread.root.id}
          onPick={() => {
            controller.focusedThread = thread.root.id;
            if (thread.root.cell) controller.goTo(thread.tabId, thread.root.cell.row, thread.root.cell.col);
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
  author,
  active,
  onPick,
}: {
  controller: SheetController;
  thread: Thread;
  tabName: string;
  people: Person[];
  author: CommentAuthor;
  active: boolean;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const tc = t.weldsheets.comments;
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  const { root } = thread;
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const cell = root.cell ? `${tabName}!${formatA1(root.cell.row, root.cell.col)}` : tc.cellDeleted;
  return (
    <div ref={ref} className={`flex flex-col gap-2 rounded-lg border bg-card p-3 ${active ? 'ring-2 ring-primary/50' : ''} ${root.resolved ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" onClick={onPick} disabled={!root.cell} title={tc.goToCell} className="min-w-0 flex-1 truncate text-left font-mono hover:text-foreground hover:underline disabled:no-underline">
          {cell}
        </button>
        {controller.mayComment && (
          <button
            type="button"
            title={root.resolved ? tc.reopen : tc.resolve}
            aria-label={root.resolved ? tc.reopen : tc.resolve}
            className="rounded p-1 hover:bg-accent [&_svg]:size-3.5"
            onClick={() => setResolved(controller, thread, !root.resolved)}
          >
            {root.resolved ? <RotateCcw /> : <Check />}
          </button>
        )}
      </div>
      {[root, ...thread.replies].map((c) => (
        <CommentEntry key={c.id} controller={controller} thread={thread} comment={c} people={people} author={author} />
      ))}
      {controller.mayComment &&
        !root.resolved &&
        (replying || active ? (
          <Composer
            people={people}
            placeholder={tc.replyPlaceholder}
            submitLabel={tc.reply}
            onSubmit={(body) => {
              reply(controller, thread, body, author);
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
  controller,
  thread,
  comment,
  people,
  author,
}: {
  controller: SheetController;
  thread: Thread;
  comment: SheetComment;
  people: Person[];
  author: CommentAuthor;
}) {
  const { t, language } = useI18n();
  const tc = t.weldsheets.comments;
  const [editing, setEditing] = useState(false);
  const own = comment.author.id === author.id && controller.mayComment;
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(comment.editedAt ?? comment.createdAt));
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary" aria-hidden>
        {initials(comment.author.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{comment.author.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {when}
            {comment.editedAt ? ` · ${tc.edited}` : ''}
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
                <DropdownMenuItem onSelect={() => removeComment(controller, thread, comment)}>{comment.id === thread.root.id ? tc.deleteThread : tc.delete}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <Composer
              people={people}
              placeholder={tc.placeholder}
              submitLabel={tc.save}
              initial={comment.body}
              autoFocus
              onSubmit={(body) => {
                editComment(controller, thread, comment, body);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">
            <Body text={comment.body} />
          </p>
        )}
      </div>
    </div>
  );
}

const MENTION = /@\[([^\]]*)\]\([^)\s]+\)/g;

/** A comment's text with mentions shown as names. */
function Body({ text }: { text: string }) {
  const parts: (string | { name: string; key: number })[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    parts.push(text.slice(last, m.index), { name: m[1]!, key: m.index! });
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <span key={`${p.key}-${i}`} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            @{p.name}
          </span>
        ),
      )}
    </>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

/** A comment box: Ctrl+Enter posts; typing @ offers the people to mention. */
function Composer({
  people,
  placeholder,
  submitLabel,
  initial = '',
  autoFocus,
  onSubmit,
  onCancel,
}: {
  people: Person[];
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const tc = t.weldsheets.comments;
  const [body, setBody] = useState(initial);
  const [query, setQuery] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [people, query]);

  const update = (value: string) => {
    setBody(value);
    const caret = ref.current?.selectionStart ?? value.length;
    const m = /@([^\s@[\]()]*)$/.exec(value.slice(0, caret));
    setQuery(m && people.length ? m[1]! : null);
  };

  const mention = (p: Person) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@[^\s@[\]()]*$/, '');
    setBody(`${before}@[${p.name.replace(/[[\]]/g, '')}](${p.id}) ${body.slice(caret)}`);
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const submit = () => {
    if (!body.trim()) return;
    onSubmit(body);
    setBody('');
    setQuery(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Enter' && matches.length) {
      e.preventDefault();
      mention(matches[0]!);
    } else if (e.key === 'Escape') {
      if (query === null) onCancel?.();
      else setQuery(null);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={body}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        maxLength={10_000}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
      />
      {query !== null && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border bg-popover p-1 text-sm shadow-md">
          {matches.length === 0 && <div className="px-2 py-1 text-muted-foreground">{tc.noMatch}</div>}
          {matches.map((p) => (
            <button key={p.id} type="button" className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent" onMouseDown={(e) => e.preventDefault()} onClick={() => mention(p)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-1">
        {onCancel && (
          <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
            {tc.cancel}
          </Button>
        )}
        <Button size="sm" className="h-7" disabled={!body.trim()} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
