import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, MoreVertical, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import type { RecordCommentMessage } from '@weldsuite/app-api-client';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { LINE_BREAK, OBJECT, PARA, caretRect, suggestionRanges, type Thread } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import { RecordChatPanelBar } from '@/app/weldchat/components/record-chat-panel-bar';
import { CommentBody, CommentComposer, initials, type ComposerLabels, type Person } from '@/components/record-comments/comment-parts';
import { fromChatContent } from '@/components/record-comments/mentions';
import { useRecordComments, type RecordCommentsState } from '@/components/record-comments/use-record-comments';
import type { DocController } from './model/doc-controller';
import { stackCards, type MarginCard } from './view/margin-cards';
import { PX_PER_PT, pageTops, pagesHeight } from './view/page-view';
import { useDocScroll } from './view/scroll-context';

export type { Person };

/** Marks, breaks and objects, shown as spaces in a suggestion's text. */
const HIDDEN = new RegExp(`[${PARA}${LINE_BREAK}${OBJECT}]`, 'g');

type Review = ReturnType<typeof useI18n>['t']['welddocs']['review'];

/**
 * The comments beside the pages, as in Google Docs: each discussion level
 * with the text it is about (suggestions with Accept and Reject), with its
 * replies and a reply box when picked, and a new comment beside its text.
 *
 * The document holds each discussion's place and whether it is resolved;
 * what is said in it is a thread in the document's WeldChat chat (ADR
 * CHAT-007), so it also shows in WeldChat, and @mentions notify from there.
 */
export function CommentsPanel({ controller, docId, people }: { controller: DocController; docId: string; people: Person[] }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const comments = useRecordComments(
    'doc',
    docId,
    controller.threads().map((t) => t.root.id),
  );
  return <Panel controller={controller} people={people} comments={comments} docId={docId} />;
}

/** Suggestions only: a document kept in the browser has no chat for comments. */
export function SuggestionsPanel({ controller }: { controller: DocController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  return <Panel controller={controller} people={[]} comments={null} docId={null} />;
}

function Panel({ controller, people, comments, docId }: { controller: DocController; people: Person[]; comments: RecordCommentsState | null; docId: string | null }) {
  const { t } = useI18n();
  const tr = t.welddocs.review;
  const [showResolved, setShowResolved] = useState(false);
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const threads = controller.threads().filter((th) => (showResolved || !th.root.resolved) && (comments || th.root.suggestion));
  // The discussion picked, or the one the caret is in.
  const sel = controller.selection;
  const active =
    controller.activeThread ??
    threads.find((th) => th.at && th.at.story === sel.story && sel.head >= th.at.from && sel.head <= th.at.to)?.root.id ??
    null;
  const labels: ComposerLabels = { placeholder: tr.commentPlaceholder, submit: tr.post, cancel: tr.cancel, noMatch: tr.mentionNoMatch };

  const post = async (body: string) => {
    const draft = controller.draftComment();
    if (!draft || !comments) return;
    try {
      await comments.start({ id: draft.thread, ...(draft.quote ? { quote: draft.quote } : {}) }, body);
    } catch (err) {
      toast.error(tr.failed);
      throw err;
    }
    controller.addComment(draft.thread);
  };

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
      {docId && comments && <RecordChatPanelBar entityType="doc" entityId={docId} channelId={comments.channelId} />}
      {comments?.isError && <p className="px-3 pt-3 text-sm text-destructive">{tr.loadFailed}</p>}
      {!controller.draft && threads.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">{tr.empty}</p>}
      <MarginCards
        controller={controller}
        draft={
          controller.draft && comments ? (
            <div className="rounded-lg border bg-card p-3 shadow-sm">
              <CommentComposer people={people} labels={labels} autoFocus onSubmit={post} onCancel={() => controller.cancelComment()} />
            </div>
          ) : null
        }
        threads={threads}
        active={active}
        renderThread={(thread) => <ThreadCard controller={controller} thread={thread} people={people} names={names} comments={comments} active={thread.root.id === active} />}
      />
    </aside>
  );
}

/** The comment being written, among the cards. */
const DRAFT = '\0draft';
/** Height assumed for a card until it has been measured. */
const CARD_GUESS = 96;

/**
 * The cards beside the pages, each level with the text it is about, moving
 * with the pages as they scroll (the wheel over the cards scrolls the pages).
 */
function MarginCards({
  controller,
  draft,
  threads,
  active,
  renderThread,
}: {
  controller: DocController;
  draft: React.ReactNode;
  threads: Thread[];
  active: string | null;
  renderThread: (thread: Thread) => React.ReactNode;
}) {
  const scroll = useDocScroll();
  const areaRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const heights = useCardHeights();

  // Where each card's text starts, in the pages' scrolled area.
  const scale = controller.zoom * PX_PER_PT;
  const tops = pageTops(controller.pages, scale);
  const textTop = (at: { story: string; from: number } | null): number | null => {
    if (!at) return null;
    const r = caretRect(controller.layout, at.story, at.from);
    return r && tops[r.page] !== undefined ? tops[r.page]! + r.y * scale : null;
  };
  const sel = controller.draft;
  const cards: MarginCard[] = threads.map((th) => ({ id: th.root.id, want: textTop(th.at), height: heights.of(th.root.id) ?? CARD_GUESS }));
  if (draft && sel) cards.push({ id: DRAFT, want: textTop({ story: sel.story, from: Math.min(sel.anchor, sel.head) }), height: heights.of(DRAFT) ?? CARD_GUESS });
  // In the order of the pages; those with no place in the text last (the sort keeps text order for ties).
  cards.sort((a, b) => (a.want ?? Infinity) - (b.want ?? Infinity) || 0);
  const placed = stackCards(cards, draft ? DRAFT : active);
  const last = cards.reduce((max, c) => Math.max(max, placed.get(c.id)! + c.height), 0);

  // Room under the last page for cards that run past it.
  const roomBelow = Math.max(0, Math.ceil(last + 16 - pagesHeight(tops)));
  const setRoomBelow = scroll?.setRoomBelow;
  useEffect(() => setRoomBelow?.(roomBelow), [setRoomBelow, roomBelow]);
  useEffect(() => () => setRoomBelow?.(0), [setRoomBelow]);

  // The cards move with the pages: the layer is shifted directly, with no render per scroll.
  const follow = useCallback(() => {
    const el = scroll?.scrollRef.current;
    const area = areaRef.current;
    const layer = layerRef.current;
    if (!el || !area || !layer) return;
    const offset = el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    layer.style.transform = `translateY(${offset - el.scrollTop}px)`;
  }, [scroll]);
  useLayoutEffect(follow);
  useEffect(() => {
    const el = scroll?.scrollRef.current;
    const area = areaRef.current;
    if (!el || !area) return;
    el.addEventListener('scroll', follow, { passive: true });
    const ro = new ResizeObserver(follow);
    ro.observe(area);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', follow);
      ro.disconnect();
    };
  }, [scroll, follow]);

  const onWheel = (e: React.WheelEvent) => {
    const el = scroll?.scrollRef.current;
    if (!el || e.ctrlKey) return;
    // A comment box that scrolls itself keeps the wheel.
    if ((e.target as HTMLElement).closest('textarea')) return;
    el.scrollBy({ top: e.deltaY, left: e.deltaX });
  };

  const byId = new Map(threads.map((th) => [th.root.id, th]));
  return (
    <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden" onWheel={onWheel}>
      <div ref={layerRef} className="absolute inset-x-0 top-0">
        {cards.map((c) => (
          <div key={c.id} ref={heights.ref(c.id)} className="absolute inset-x-3 transition-[top] duration-150 ease-out motion-reduce:transition-none" style={{ top: placed.get(c.id) }}>
            {c.id === DRAFT ? draft : renderThread(byId.get(c.id)!)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Measures the cards as they render and grow (a reply box opening, a long comment). */
function useCardHeights() {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const els = useRef(new Map<string, HTMLDivElement>());
  const refs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const measure = useCallback(() => {
    setHeights((prev) => {
      let changed = prev.size !== els.current.size;
      const next = new Map<string, number>();
      for (const [id, el] of els.current) {
        const h = el.offsetHeight;
        next.set(id, h);
        if (prev.get(id) !== h) changed = true;
      }
      return changed ? next : prev;
    });
  }, []);
  const [observer] = useState(() => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)));
  useEffect(() => () => observer?.disconnect(), [observer]);
  // A new card's height, before it paints.
  useLayoutEffect(measure);
  return {
    of: (id: string) => heights.get(id),
    ref: (id: string) => {
      let fn = refs.current.get(id);
      if (!fn) {
        fn = (el) => {
          const old = els.current.get(id);
          if (old) observer?.unobserve(old);
          if (el) {
            els.current.set(id, el);
            observer?.observe(el);
          } else {
            els.current.delete(id);
            refs.current.delete(id);
          }
        };
        refs.current.set(id, fn);
      }
      return fn;
    },
  };
}

function ThreadCard({
  controller,
  thread,
  people,
  names,
  comments,
  active,
}: {
  controller: DocController;
  thread: Thread;
  people: Person[];
  names: ReadonlyMap<string, string>;
  comments: RecordCommentsState | null;
  active: boolean;
}) {
  const { t, language } = useI18n();
  const tr = t.welddocs.review;
  const root = thread.root;
  const me = controller.reviewer.id;
  const canComment = !!comments && controller.commentsAvailable && (controller.canComment || !controller.readOnly);
  const suggestion = root.suggestion ? describeSuggestion(controller, root.suggestion, tr) : null;
  const messages = comments?.threads.get(root.id)?.messages ?? [];
  // A discussion goes as a whole only while nobody else has said anything in it.
  const deletable = !root.suggestion && root.author.id === me && messages.every((m) => m.authorId === me);
  const labels: ComposerLabels = { placeholder: tr.replyPlaceholder, submit: tr.reply, cancel: tr.cancel, noMatch: tr.mentionNoMatch };

  const deleteThread = async () => {
    try {
      await comments?.remove(messages.map((m) => m.id));
    } catch {
      toast.error(tr.failed);
      return;
    }
    controller.deleteThread(root.id);
  };
  /** A reply goes alone; the discussion's first comment goes with the discussion, when it may. */
  const onDeleteOf = (m: RecordCommentMessage, first: boolean) => {
    if (!first) return () => void comments?.remove([m.id]).catch(() => toast.error(tr.failed));
    return deletable ? deleteThread : undefined;
  };

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
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          {root.quote && !suggestion && <p className="mb-2 line-clamp-2 border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">{root.quote}</p>}
          {!thread.at && !suggestion && <p className="mb-2 text-xs italic text-muted-foreground">{tr.textGone}</p>}
        </div>
        {!root.resolved && canComment && (
          <button type="button" aria-label={tr.resolve} title={tr.resolve} className="rounded p-1 text-blue-600 hover:bg-accent" onClick={(e) => {
            e.stopPropagation();
            controller.setResolved(root.id, true);
          }}>
            <Check className="size-4" />
          </button>
        )}
      </div>
      {suggestion !== null && (
        <div>
          <Byline name={root.author.id === me ? tr.you : root.author.name || tr.someone} at={root.createdAt} language={language} />
          <p className="mt-1 text-sm">{suggestion}</p>
          {!controller.readOnly && (
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
        </div>
      )}
      {suggestion === null && messages.length === 0 && <p className="text-xs italic text-muted-foreground">{comments?.isLoading ? tr.loading : tr.missing}</p>}
      {messages.map((m, i) => (
        <div key={m.id} className={i > 0 || suggestion !== null ? 'mt-3 border-t pt-3' : ''}>
          <CommentEntry
            message={m}
            people={people}
            names={names}
            own={m.authorId === me && canComment}
            first={i === 0 && suggestion === null}
            onDelete={onDeleteOf(m, i === 0 && suggestion === null)}
            onEdit={(body) =>
              comments!.edit(m.id, body).catch((err) => {
                toast.error(tr.failed);
                throw err;
              })
            }
          />
        </div>
      ))}
      {active && canComment && !root.resolved && (
        <div className="mt-3 border-t pt-3" onClick={(e) => e.stopPropagation()}>
          <CommentComposer
            people={people}
            labels={labels}
            onSubmit={async (body) => {
              try {
                await comments!.reply({ id: root.id, ...(root.quote ? { quote: root.quote } : {}) }, body);
              } catch (err) {
                toast.error(tr.failed);
                throw err;
              }
            }}
          />
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
function describeSuggestion(controller: DocController, id: string, tr: Review): string {
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

function Byline({ name, at, edited, language, children }: { name: string; at: number; edited?: boolean; language: string; children?: React.ReactNode }) {
  const { t } = useI18n();
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return (
    <div className="flex items-start gap-2">
      <Avatar className="size-7 shrink-0">
        <AvatarFallback className="bg-blue-600 text-xs font-medium text-white">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">
          {when}
          {edited ? ` · ${t.welddocs.review.edited}` : ''}
        </div>
      </div>
      {children}
    </div>
  );
}

/** One message of a discussion; \`first\`: the discussion's first comment, which deletes the discussion. */
function CommentEntry({
  message,
  people,
  names,
  own,
  first,
  onDelete,
  onEdit,
}: {
  message: RecordCommentMessage;
  people: Person[];
  names: ReadonlyMap<string, string>;
  own: boolean;
  first: boolean;
  onDelete?: () => void;
  onEdit: (body: string) => Promise<unknown>;
}) {
  const { t, language } = useI18n();
  const tr = t.welddocs.review;
  const [editing, setEditing] = useState(false);
  const labels: ComposerLabels = { placeholder: tr.commentPlaceholder, submit: tr.save, cancel: tr.cancel, noMatch: tr.mentionNoMatch };
  return (
    <div>
      <Byline name={own ? tr.you : message.authorName || tr.someone} at={new Date(message.createdAt).getTime()} edited={message.isEdited} language={language}>
        {own && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={tr.edit} className="rounded p-1 hover:bg-accent" onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => setEditing(true)}>{tr.edit}</DropdownMenuItem>
              {onDelete && <DropdownMenuItem onSelect={onDelete}>{first ? tr.deleteThread : tr.delete}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Byline>
      {editing ? (
        <div className="mt-2">
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
        <div className="mt-1.5">
          <CommentBody content={message.content} names={names} />
        </div>
      )}
    </div>
  );
}
