import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, MoreVertical, RotateCcw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { BoardElement } from '@weldsuite/board-engine';
import type { RecordCommentMessage } from '@weldsuite/app-api-client';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { FilterButton } from '@weldsuite/ui/components/filter-button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { CommentAuthorAvatar, CommentBody, CommentComposer, type ComposerLabels, type Person } from '@/components/record-comments/comment-parts';
import { fromChatContent } from '@/components/record-comments/mentions';
import { useRecordComments, type RecordCommentsState } from '@/components/record-comments/use-record-comments';
import type { BoardController } from '../editor/model/board-controller';
import { SIDE_PANEL, SIDE_PANEL_HEADER } from '../editor/ui';
import { activeFilterCount, commentMatches, DEFAULT_COMMENT_FILTERS, type CommentFilters } from './comment-filters';
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
 * open ones unless the filter says otherwise, narrowed by the search. What
 * is said is a thread in the board's WeldChat chat (ADR CHAT-007), so
 * comments show in WeldChat too and @mentions notify from there; the board
 * keeps only the pins.
 */
export function CommentsPanel({ controller: c, boardId, people, panels }: { controller: BoardController; boardId: string; people: Person[]; panels: BoardPanels }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const state = useSyncExternalStore(panels.subscribe, panels.get);
  const { t, format } = useI18n();
  const tc = t.weldboard.editor.comments;
  const [filters, setFilters] = useState<CommentFilters>(DEFAULT_COMMENT_FILTERS);
  const pins = [...c.board.elements.values()].filter((e) => e.type === 'comment').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const comments = useRecordComments('board', boardId, pins.map(threadOf));
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const mayComment = !c.readOnly || c.canComment;
  const labelOf = (pin: BoardElement) => pinLabel(c, pin, tc.onBoard);
  // The pin just picked or placed always shows, whatever the filters say.
  const shown = pins.filter(
    (p) => p.id === state.activeComment || commentMatches(p, { label: labelOf(p), messages: comments.threads.get(threadOf(p))?.messages ?? [] }, filters, c.options.userId),
  );
  // Nothing shows only because resolved threads are hidden: offer those, rather than "nothing matches".
  const onlyResolvedHidden = filters.status === 'open' && filters.people === 'everyone' && !filters.query.trim();
  const resolvedCount = pins.filter((p) => p.resolved).length;

  // A pin just placed has no message yet: when its first comment is dropped, the pin goes too.
  const dropEmptyPin = (pin: BoardElement) => {
    if (!comments.threads.get(threadOf(pin))?.messages.length && pin.createdBy === c.options.userId) c.apply({ type: 'delete', ids: [pin.id] }, { comment: true });
  };

  return (
    <aside className={SIDE_PANEL} aria-label={tc.title}>
      <div className={SIDE_PANEL_HEADER}>
        <h2 className="text-sm font-semibold">{tc.title}</h2>
        <Button size="icon" variant="ghost" className="size-7" aria-label={tc.close} onClick={() => panels.close()}>
          <X className="size-4" />
        </Button>
      </div>
      <search className="flex items-center gap-2 border-b px-3 py-2">
        <CommentFilterButton filters={filters} onChange={setFilters} />
        <PanelSearch value={filters.query} onChange={(query) => setFilters((f) => ({ ...f, query }))} placeholder={tc.searchPlaceholder} />
      </search>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {comments.isError && <p className="px-1 text-sm text-destructive">{tc.loadFailed}</p>}
        {/* Nothing shown: nothing at all, only resolved threads hidden, or nothing matching the filters and search. */}
        {shown.length === 0 && pins.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{tc.empty}</p>}
        {shown.length === 0 && pins.length > 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm text-muted-foreground">
            <p>{onlyResolvedHidden ? tc.noneOpen : tc.noMatches}</p>
            {onlyResolvedHidden ? (
              <Button size="sm" variant="outline" onClick={() => setFilters((f) => ({ ...f, status: 'all' }))}>
                {resolvedCount === 1 ? tc.showResolvedOne : format(tc.showResolvedCount, { count: resolvedCount })}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setFilters(DEFAULT_COMMENT_FILTERS)}>
                {tc.clearFilters}
              </Button>
            )}
          </div>
        )}
        {shown.map((pin) => (
          <ThreadCard
            key={pin.id}
            controller={c}
            pin={pin}
            label={labelOf(pin)}
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

/** The Filter button and its choices: which threads (status) and whose (people). */
function CommentFilterButton({ filters, onChange }: { filters: CommentFilters; onChange: (next: CommentFilters) => void }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.comments;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterButton count={activeFilterCount(filters)}>{t.common.actions.filter}</FilterButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[248px] space-y-3 p-3">
        <FilterChoices
          label={tc.status}
          value={filters.status}
          options={[
            ['open', tc.open],
            ['resolved', tc.resolved],
            ['all', tc.all],
          ]}
          onChange={(status) => onChange({ ...filters, status })}
        />
        <FilterChoices
          label={tc.people}
          value={filters.people}
          options={[
            ['everyone', tc.everyone],
            ['mentions', tc.mentionsMe],
            ['mine', tc.mine],
          ]}
          onChange={(people) => onChange({ ...filters, people })}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * One group of choices in a filter popover: pills, of which exactly one is
 * on (a radio group: arrow keys move between them).
 */
function FilterChoices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (next: T) => void }) {
  const id = useId();
  return (
    <div>
      <p id={id} className="mb-2 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-labelledby={id}
        value={value}
        // Picking the pill that is on keeps it on: one of them always is.
        onValueChange={(next) => next && onChange(next as T)}
        className="w-full flex-wrap gap-1.5 data-[variant=outline]:shadow-none"
      >
        {options.map(([option, text]) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className="h-7 flex-none rounded-md px-2.5 text-xs data-[variant=outline]:border-l data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
          >
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * The search: a button until it is wanted, then a search bar across the
 * row. Esc clears it; leaving it empty folds it back into the button.
 */
function PanelSearch({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(value !== '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <Button variant="outline" size="sm" className="ms-auto size-8 shrink-0 p-0 shadow-none" aria-label={t.common.actions.search} title={t.common.actions.search} onClick={() => setOpen(true)}>
        <Search className="size-4" />
      </Button>
    );
  }
  return (
    <SearchInput
      ref={input}
      type="search"
      className="min-w-0 flex-1"
      // The browser's own clear button would be the only one in the app's search bars: Esc clears instead.
      inputClassName="[&::-webkit-search-cancel-button]:appearance-none"
      value={value}
      placeholder={placeholder}
      aria-label={t.common.actions.search}
      enterKeyHint="search"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => value === '' && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onChange('');
        setOpen(false);
      }}
    />
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
  // A pin just placed: its box takes the keyboard once the click that placed it is over
  // (the board keeps focus through that click).
  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [fresh]);

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
  // The first message's delete takes the whole thread, when that is allowed.
  const deleteWholeThread = () => void deleteThread();
  const deleteFirst = deletable ? deleteWholeThread : undefined;
  const labels: ComposerLabels = { placeholder: messages.length ? tc.replyPlaceholder : tc.placeholder, submit: messages.length ? tc.reply : tc.send, cancel: tc.cancel, noMatch: tc.noMatch };

  return (
    <div ref={ref} className={`flex flex-col gap-2 rounded-lg border bg-card p-3 ${active ? 'ring-2 ring-primary/50' : ''} ${pin.resolved ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" onClick={onPick} title={tc.goTo} className="min-w-0 flex-1 truncate text-left hover:text-foreground hover:underline">
          {label}
        </button>
        {pin.resolved && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{tc.resolved}</span>}
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
          onDelete={i === 0 ? deleteFirst : () => void comments.remove([m.id]).catch(() => toast.error(tc.failed))}
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
      <CommentAuthorAvatar message={message} />
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
