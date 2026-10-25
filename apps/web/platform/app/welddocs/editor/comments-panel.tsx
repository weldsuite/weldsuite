import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Check, MoreVertical, RotateCcw, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { LINE_BREAK, OBJECT, PARA, suggestionRanges, type CommentInput, type DocComment, type Thread } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';

/** Someone who can be mentioned. */
export interface Person {
  id: string;
  name: string;
}

/** Marks, breaks and objects, shown as spaces in a suggestion's text. */
const HIDDEN = new RegExp(`[${PARA}${LINE_BREAK}${OBJECT}]`, 'g');
const MENTION = /@\[([^\]]*)\]\(([^)\s]+)\)/g;

/** The people a body mentions (`@[Name](id)`), each once. */
export function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[2]!))];
}

function inputOf(body: string): CommentInput {
  const mentions = mentionsIn(body);
  return mentions.length ? { body: body.trim(), mentions } : { body: body.trim() };
}

/**
 * The comments beside the pages, as in Google Docs: a new comment being
 * written, then every discussion in the order of the text (suggestions with
 * Accept and Reject), each with its replies and a reply box when picked.
 */
export function CommentsPanel({ controller, people }: { controller: DocController; people: Person[] }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const tr = t.welddocs.review;
  const [showResolved, setShowResolved] = useState(false);
  const threads = controller.threads().filter((th) => showResolved || !th.root.resolved);
  // The discussion picked, or the one the caret is in.
  const sel = controller.selection;
  const active =
    controller.activeThread ??
    threads.find((th) => th.at && th.at.story === sel.story && sel.head >= th.at.from && sel.head <= th.at.to)?.root.id ??
    null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background" aria-label={tr.comments}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="font-medium">{tr.comments}</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          {tr.showResolved}
        </label>
        <button type="button" aria-label={tr.cancel} className="rounded p-1 hover:bg-accent" onClick={() => controller.setShowComments(false)}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {controller.draft && (
          <div className="rounded-lg border bg-card p-3 shadow-sm">
            <Composer
              people={people}
              placeholder={tr.commentPlaceholder}
              submitLabel={tr.post}
              autoFocus
              onSubmit={(input) => controller.addComment(input)}
              onCancel={() => controller.cancelComment()}
            />
          </div>
        )}
        {!controller.draft && threads.length === 0 && <p className="px-1 py-6 text-center text-sm text-muted-foreground">{tr.empty}</p>}
        {threads.map((thread) => (
          <ThreadCard key={thread.root.id} controller={controller} thread={thread} people={people} active={thread.root.id === active} />
        ))}
      </div>
    </aside>
  );
}

function ThreadCard({ controller, thread, people, active }: { controller: DocController; thread: Thread; people: Person[]; active: boolean }) {
  const { t } = useI18n();
  const tr = t.welddocs.review;
  const root = thread.root;
  const canComment = controller.canComment || !controller.readOnly;
  const suggestion = root.suggestion ? describeSuggestion(controller, root.suggestion, tr) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`rounded-lg border bg-card p-3 text-sm shadow-sm outline-none transition-shadow ${active ? 'ring-2 ring-blue-500/60' : 'hover:shadow'} ${root.resolved ? 'opacity-70' : ''}`}
      onClick={() => controller.selectThread(root.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) controller.selectThread(root.id);
      }}
    >
      {root.quote && !suggestion && <p className="mb-2 line-clamp-2 border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">{root.quote}</p>}
      {!thread.at && !suggestion && <p className="mb-2 text-xs italic text-muted-foreground">{tr.textGone}</p>}
      <CommentItem controller={controller} comment={root} people={people} deletable={!controller.readOnly || thread.replies.every((r) => r.author.id === controller.reviewer.id)}>
        {suggestion !== null && <p className="mt-1 text-sm">{suggestion}</p>}
      </CommentItem>
      {suggestion !== null && !controller.readOnly && (
        <div className="mt-2 flex gap-1">
          <Button size="sm" variant="outline" className="h-7 gap-1" aria-label={tr.accept} onClick={(e) => {
            e.stopPropagation();
            controller.resolveSuggestion(root.suggestion!, true);
          }}>
            <Check className="size-3.5" />
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1" aria-label={tr.reject} onClick={(e) => {
            e.stopPropagation();
            controller.resolveSuggestion(root.suggestion!, false);
          }}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
      {thread.replies.map((reply) => (
        <div key={reply.id} className="mt-3 border-t pt-3">
          <CommentItem controller={controller} comment={reply} people={people} />
        </div>
      ))}
      {active && canComment && !root.resolved && (
        <div className="mt-3 border-t pt-3" onClick={(e) => e.stopPropagation()}>
          <Composer people={people} placeholder={tr.replyPlaceholder} submitLabel={tr.reply} onSubmit={(input) => controller.reply(root.id, input)} />
        </div>
      )}
      {root.resolved && canComment && (
        <Button size="sm" variant="ghost" className="mt-2 h-7 gap-1 px-2" onClick={(e) => {
          e.stopPropagation();
          controller.setResolved(root.id, false);
        }}>
          <RotateCcw className="size-3.5" />
          {tr.reopen}
        </Button>
      )}
    </div>
  );
}

/** "Add …", "Delete …" or "Replace … with …" for a suggestion's text. */
function describeSuggestion(controller: DocController, id: string, tr: ReturnType<typeof useI18n>['t']['welddocs']['review']): string {
  let added = '';
  let removed = '';
  for (const r of suggestionRanges(controller.doc, id)) {
    const text = controller.doc.stories.get(r.story)!.text(r.from, r.to).replace(HIDDEN, ' ');
    if (r.kind === 'insert') added += text;
    else if (r.kind === 'delete') removed += text;
  }
  const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s).trim();
  if (added && removed) return tr.suggestedChange.replace('{removed}', clip(removed)).replace('{added}', clip(added));
  if (removed) return tr.suggestedDelete.replace('{text}', clip(removed));
  return tr.suggestedAdd.replace('{text}', clip(added));
}

/** `deletable`: a commenter may not delete a discussion others have replied in (it would take their replies too). */
function CommentItem({
  controller,
  comment,
  people,
  deletable = true,
  children,
}: {
  controller: DocController;
  comment: DocComment;
  people: Person[];
  deletable?: boolean;
  children?: React.ReactNode;
}) {
  const { t, language } = useI18n();
  const tr = t.welddocs.review;
  const [editing, setEditing] = useState(false);
  const mine = comment.author.id === controller.reviewer.id;
  const isRoot = comment.thread === comment.id;
  const canComment = controller.canComment || !controller.readOnly;
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(comment.createdAt));
  const name = mine ? tr.you : comment.author.name || tr.someone;
  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-medium text-white">{initials(name)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">
            {when}
            {comment.editedAt ? ` · ${tr.edited}` : ''}
          </div>
        </div>
        {isRoot && !comment.resolved && canComment && (
          <button type="button" aria-label={tr.resolve} title={tr.resolve} className="rounded p-1 text-blue-600 hover:bg-accent" onClick={(e) => {
            e.stopPropagation();
            controller.setResolved(comment.id, true);
          }}>
            <Check className="size-4" />
          </button>
        )}
        {mine && canComment && !comment.suggestion && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={tr.edit} className="rounded p-1 hover:bg-accent" onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => setEditing(true)}>{tr.edit}</DropdownMenuItem>
              {deletable && <DropdownMenuItem onSelect={() => controller.deleteComment(comment.id)}>{tr.delete}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <Composer
            people={people}
            initial={comment.body}
            placeholder={tr.commentPlaceholder}
            submitLabel={tr.save}
            autoFocus
            onSubmit={(input) => {
              controller.editComment(comment.id, input);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        comment.body && <p className="mt-1.5 whitespace-pre-wrap break-words text-sm">{renderBody(comment.body)}</p>
      )}
      {children}
    </div>
  );
}

function renderBody(body: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION)) {
    if (m.index! > last) out.push(body.slice(last, m.index));
    out.push(
      <span key={m.index} className="rounded bg-blue-500/10 px-0.5 font-medium text-blue-700 dark:text-blue-400">
        @{m[1]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
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
  onSubmit: (input: CommentInput) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const tr = t.welddocs.review;
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
    const next = `${before}@[${p.name.replace(/[[\]]/g, '')}](${p.id}) ${body.slice(caret)}`;
    setBody(next);
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const submit = () => {
    if (!body.trim()) return;
    onSubmit(inputOf(body));
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
      if (query !== null) setQuery(null);
      else onCancel?.();
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
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
      />
      {query !== null && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border bg-popover p-1 text-sm shadow-md">
          {matches.length === 0 && <div className="px-2 py-1 text-muted-foreground">{tr.mentionNoMatch}</div>}
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
            {tr.cancel}
          </Button>
        )}
        <Button size="sm" className="h-7" disabled={!body.trim()} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
