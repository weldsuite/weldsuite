import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, MessageSquareText, Reply } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { ChatContext } from '@/app/weldchat/components/chat-context';
import { MessageInput } from '@/app/weldchat/components/message-input';
import { renderMessageBlocks } from '@/app/weldchat/lib/render-message-blocks';
import { messagePlainText } from '@/app/weldchat/lib/render-message-content';
import { useObjectChatContext } from '@/components/objects/_shared/object-chat';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { useMergePullRequestThreads } from '@/hooks/queries/use-weldmerge-review-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { fill, providerChatMarkdown, providerPreviewText } from '../../lib/format';

interface ConversationProps {
  pullRequestId: string;
  canReview: boolean;
  onReply: (thread: MergeReviewThread, body: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
}

type ThreadComment = MergeReviewThread['comments'][number];

/** Same author within five minutes on the same day: the chat's rule for leaving out the header. */
const GROUP_WINDOW_MS = 5 * 60_000;

function startedAt(thread: MergeReviewThread): number {
  return Date.parse(thread.comments[0]?.createdAt ?? '') || 0;
}

/** Where a thread sits: a file and line, a file, or nothing for a comment on the whole pull request. */
function threadPlace(thread: MergeReviewThread, onLine: string): string | null {
  if (!thread.path) return null;
  return thread.line === null ? thread.path : fill(onLine, { path: thread.path, line: thread.line });
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The chat's day divider. */
function DayDivider({ at }: Readonly<{ at: string }>) {
  return (
    <div className="flex items-center gap-4 my-4 px-2 md:px-4">
      <div className="flex-1 border-t" />
      <span className="text-xs text-muted-foreground font-medium">
        {new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
      </span>
      <div className="flex-1 border-t" />
    </div>
  );
}

/**
 * One provider comment laid out as a chat message (`MessageItem`): avatar,
 * name and time, the body in the chat's Markdown, a reply reference when it
 * answers an earlier comment, and the hover bar. A provider comment cannot
 * take chat reactions, threads or edits, so the bar only offers Reply and the
 * provider link.
 */
function CommentRow({
  comment,
  compact,
  place,
  replyTo,
  canReply,
  onReply,
}: Readonly<{
  comment: ThreadComment;
  compact: boolean;
  /** Where a review thread sits in the diff, above its first comment. */
  place: string | null;
  /** The comment this one answers. */
  replyTo: ThreadComment | null;
  canReply: boolean;
  onReply: () => void;
}>) {
  const { t } = useI18n();
  const tr = t.weldmerge.reviewing.conversation;
  const [hovered, setHovered] = useState(false);
  const name = comment.author?.login ?? tr.unknownAuthor;
  const time = new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fullTime = new Date(comment.createdAt).toLocaleString();
  const body = useMemo(() => renderMessageBlocks(providerChatMarkdown(comment.body)), [comment.body]);

  return (
    <div
      data-testid="merge-conversation-comment"
      className={cn(
        'group group/message relative px-2 md:px-4 py-1 hover:bg-muted/50 transition-colors border-l-2 border-l-transparent',
        compact && 'py-0.5',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {replyTo && (
        <div className="flex items-center gap-1.5 ml-[13px] mb-0.5 text-xs text-muted-foreground">
          <div className="w-[22px] h-3 border-l-2 border-t-2 border-muted-foreground/40 rounded-tl-md" />
          <div className="flex items-center gap-1.5 -translate-y-[4px] min-w-0">
            <Avatar className="h-4 w-4">
              {replyTo.author?.avatarUrl && <AvatarImage src={replyTo.author.avatarUrl} />}
              <AvatarFallback className="text-[8px]">{(replyTo.author?.login ?? '?')[0]}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-foreground/70">{replyTo.author?.login ?? tr.unknownAuthor}</span>
            <span className="truncate max-w-[300px]">{providerPreviewText(replyTo.body)}</span>
          </div>
        </div>
      )}
      {place && (
        <div className="flex items-center gap-1.5 ml-[13px] mb-0.5 text-xs text-muted-foreground">
          <MessageSquareText className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[420px]">{place}</span>
        </div>
      )}
      <div className="flex items-start gap-2 md:gap-3">
        {compact ? (
          <div className="w-7 flex-shrink-0 flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">{time}</span>
          </div>
        ) : (
          <Avatar className="h-7 w-7 flex-shrink-0" style={{ marginTop: '3px' }}>
            {comment.author?.avatarUrl && <AvatarImage src={comment.author.avatarUrl} />}
            <AvatarFallback className="text-[9px]">{name[0]?.toUpperCase() ?? '?'}</AvatarFallback>
          </Avatar>
        )}
        <div className="flex-1 min-w-0">
          {!compact && (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">{name}</span>
              <span className="text-xs text-muted-foreground" title={fullTime}>
                {time}
              </span>
            </div>
          )}
          <div className="text-sm whitespace-pre-wrap break-words">{body}</div>
        </div>
      </div>

      {hovered && (canReply || comment.url) && (
        <div className="absolute -top-3 right-4 flex items-center gap-0.5 bg-background border rounded-[12px] shadow-sm p-1">
          {canReply && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title={tr.reply} aria-label={tr.reply} onClick={onReply}>
              <Reply className="h-3.5 w-3.5" />
            </Button>
          )}
          {comment.url && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title={tr.viewOnProvider} aria-label={tr.viewOnProvider} asChild>
              <a href={comment.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A resolved review thread starts folded to its place, like a collapsed chat notice. */
function ResolvedThreadToggle({
  place,
  open,
  onToggle,
}: Readonly<{ place: string | null; open: boolean; onToggle: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldmerge.reviewing.conversation;
  return (
    <div className="flex items-center gap-1.5 px-2 md:px-4 py-1 text-xs text-muted-foreground">
      <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? tr.hideResolved : tr.showResolved}
      </Button>
      {place && <span className="min-w-0 truncate">{place}</span>}
      <SoftBadge tone="success">{tr.resolved}</SoftBadge>
    </div>
  );
}

/**
 * The Conversation tab of a pull request: the provider's general comments and
 * review threads, oldest first, laid out with the chat's message parts, and
 * the chat's composer (`MessageInput`) held at the bottom of the tab. Reply on
 * a comment puts the composer in reply mode; what is sent is posted on the
 * provider as plain text (mentions as `@Name`), never as a chat message.
 */
export function Conversation({ pullRequestId, canReview, onReply, onComment }: Readonly<ConversationProps>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tc = tm.reviewing.conversation;
  const threads = useMergePullRequestThreads(pullRequestId);
  const chat = useObjectChatContext(null);
  const [openResolved, setOpenResolved] = useState<ReadonlySet<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef<number | null>(null);

  const { data: membersData } = useWorkspaceMembers();
  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of (membersData?.data ?? []) as Array<{ userId?: string; name?: string }>) {
      if (member.userId && member.name) map.set(member.userId, member.name);
    }
    return map;
  }, [membersData]);

  const ordered = useMemo(() => [...(threads.data ?? [])].sort((a, b) => startedAt(a) - startedAt(b)), [threads.data]);
  const commentCount = ordered.reduce((sum, thread) => sum + thread.comments.length, 0);

  // The Details tab opens at the top, on the properties; a comment that
  // arrives while it is open (the one just sent) is brought into view.
  useEffect(() => {
    if (!threads.isSuccess) return;
    if (seenCount.current !== null && commentCount > seenCount.current) {
      endRef.current?.scrollIntoView?.({ block: 'end' });
    }
    seenCount.current = commentCount;
  }, [commentCount, threads.isSuccess]);

  // The reply target at the moment of sending: the composer clears it right after.
  const replyToRef = useRef(chat.replyTo);
  replyToRef.current = chat.replyTo;

  const send = async ({ content, attachments }: { content: string; attachments: unknown[] }) => {
    if (attachments.length > 0) toast.info(tc.filesNotPosted);
    const body = messagePlainText(content, membersMap);
    if (body === '') return;
    const target = replyToRef.current;
    const thread = target ? ordered.find((candidate) => candidate.id === target.messageId) : undefined;
    // A failure is reported by the panel and rethrown, so the composer puts the text and reply target back.
    if (thread) await onReply(thread, body);
    else await onComment(body);
  };

  const startReply = (thread: MergeReviewThread, comment: ThreadComment) =>
    chat.setReplyTo({
      messageId: thread.id,
      authorName: comment.author?.login ?? tc.unknownAuthor,
      content: providerPreviewText(comment.body),
      parentId: null,
    });

  const heading = (
    <h3 className="px-4 pt-4 text-sm font-medium">
      {tc.heading}
      {commentCount > 0 && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{commentCount}</span>}
    </h3>
  );

  if (threads.isLoading || threads.isError || !threads.data) {
    return (
      <section aria-label={tc.heading} className="border-t border-border">
        {heading}
        {threads.isLoading ? (
          <InlineSpinner />
        ) : (
          <div className="p-4">
            <ErrorState message={tc.loadFailed} retryLabel={tm.retry} onRetry={() => void threads.refetch()} />
          </div>
        )}
      </section>
    );
  }

  const rows: ReactNode[] = [];
  let previous: ThreadComment | null = null;
  for (const thread of ordered) {
    const place = threadPlace(thread, tc.onLine);
    const folded = thread.resolved && !openResolved.has(thread.id);
    if (thread.resolved) {
      rows.push(
        <ResolvedThreadToggle
          key={`${thread.id}:resolved`}
          place={place}
          open={!folded}
          onToggle={() =>
            setOpenResolved((current) => {
              const next = new Set(current);
              if (next.has(thread.id)) next.delete(thread.id);
              else next.add(thread.id);
              return next;
            })
          }
        />,
      );
    }
    if (folded) {
      previous = null;
      continue;
    }
    thread.comments.forEach((comment, index) => {
      const showDate = !previous || !sameDay(previous.createdAt, comment.createdAt);
      if (showDate) rows.push(<DayDivider key={`${comment.id}:day`} at={comment.createdAt} />);
      // A reply answers the thread's first comment (the provider's `in_reply_to`).
      const replyTo = index > 0 ? (thread.comments[0] ?? null) : null;
      const gap = previous ? Date.parse(comment.createdAt) - Date.parse(previous.createdAt) : Number.NaN;
      const compact =
        !!previous &&
        !replyTo &&
        index === 0 &&
        !place &&
        !showDate &&
        previous.author?.login === comment.author?.login &&
        gap >= 0 &&
        gap < GROUP_WINDOW_MS;
      rows.push(
        <CommentRow
          key={comment.id}
          comment={comment}
          compact={compact}
          place={index === 0 && !thread.resolved ? place : null}
          replyTo={replyTo}
          canReply={canReview}
          onReply={() => startReply(thread, comment)}
        />,
      );
      previous = comment;
    });
  }

  return (
    <ChatContext.Provider value={chat}>
      {/* Under the Details rows, filling the rest of the tab: the composer stays at the bottom while it scrolls. */}
      <section aria-label={tc.heading} className="flex flex-1 flex-col border-t border-border">
        {heading}
        <div className="flex-1">
          {rows.length === 0 ? (
            <EmptyText>{tc.empty}</EmptyText>
          ) : (
            <div className="flex flex-col pt-2 pb-4 space-y-1">{rows}</div>
          )}
          <div ref={endRef} />
        </div>
        {canReview && (
          <div className="sticky bottom-0 bg-background">
            <MessageInput channelId="" placeholder={tc.newCommentPlaceholder} saveDraft={false} onSubmitOverride={send} />
          </div>
        )}
      </section>
    </ChatContext.Provider>
  );
}
