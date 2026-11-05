import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { useI18n } from '@/lib/i18n/provider';
import { fill, relativeTime } from '../../lib/format';
import { MarkdownBody, ProviderAvatar } from '../primitives';

interface ThreadCardProps {
  thread: MergeReviewThread;
  /** Shows the file and line the thread is anchored to (the conversation tab). */
  showLocation?: boolean;
  canReply: boolean;
  onReply: (thread: MergeReviewThread, body: string) => Promise<void>;
}

/** One review thread or general comment with its replies. A resolved thread starts collapsed. */
export function ThreadCard({ thread, showLocation = false, canReply, onReply }: Readonly<ThreadCardProps>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tr = tm.reviewing.conversation;
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await onReply(thread, body.trim());
      setBody('');
      setReplying(false);
    } catch {
      // The page reports the failure; the draft stays so nothing typed is lost.
    } finally {
      setSending(false);
    }
  };

  const first = thread.comments[0];
  let location: string | null = null;
  if (showLocation && thread.path) {
    location = thread.line === null ? thread.path : fill(tr.onLine, { path: thread.path, line: thread.line });
  }

  return (
    <div className="rounded-lg border bg-card text-sm" data-testid="review-thread">
      {(location || thread.resolved) && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
          {thread.resolved && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {open ? tr.hideResolved : tr.showResolved}
            </Button>
          )}
          {location && <code className="min-w-0 flex-1 truncate">{location}</code>}
          {thread.resolved && <SoftBadge tone="success">{tr.resolved}</SoftBadge>}
        </div>
      )}

      {!open && first && (
        <p className="truncate px-3 py-2 text-muted-foreground">
          <span className="font-medium text-foreground">{first.author?.login ?? tr.unknownAuthor}</span> {first.body}
        </p>
      )}

      {open && (
        <ul className="divide-y">
          {thread.comments.map((comment) => (
            <li key={comment.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <ProviderAvatar login={comment.author?.login ?? null} avatarUrl={comment.author?.avatarUrl} />
                <span className="font-medium">{comment.author?.login ?? tr.unknownAuthor}</span>
                <span className="text-xs text-muted-foreground">{relativeTime(comment.createdAt, language, tm.justNow)}</span>
                {comment.url && (
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    aria-label={tr.viewOnProvider}
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
              <MarkdownBody>{comment.body}</MarkdownBody>
            </li>
          ))}
        </ul>
      )}

      {open && canReply && (
        <div className="border-t p-2">
          {replying ? (
            <div className="space-y-2">
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={tr.replyPlaceholder}
                aria-label={tr.replyPlaceholder}
                rows={3}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setReplying(false)}>
                  {t.common.actions.cancel}
                </Button>
                <Button size="sm" disabled={body.trim() === '' || sending} onClick={() => void send()}>
                  {tr.sendReply}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
              {tr.reply}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
