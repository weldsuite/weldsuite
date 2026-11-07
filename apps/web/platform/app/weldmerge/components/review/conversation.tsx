import { useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeReviewThread } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import { useMergePullRequestThreads } from '@/hooks/queries/use-weldmerge-review-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ThreadCard } from './thread-card';

interface ConversationProps {
  pullRequestId: string;
  canReview: boolean;
  onReply: (thread: MergeReviewThread, body: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
}

function startedAt(thread: MergeReviewThread): number {
  return Date.parse(thread.comments[0]?.createdAt ?? '') || 0;
}

/** The Conversation tab: general comments and review threads in time order, and a box for a new comment. */
export function Conversation({ pullRequestId, canReview, onReply, onComment }: Readonly<ConversationProps>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tc = tm.reviewing.conversation;
  const threads = useMergePullRequestThreads(pullRequestId);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const ordered = useMemo(() => [...(threads.data ?? [])].sort((a, b) => startedAt(a) - startedAt(b)), [threads.data]);

  const send = async () => {
    setSending(true);
    try {
      await onComment(body.trim());
      setBody('');
    } catch {
      // The page reports the failure; the text stays.
    } finally {
      setSending(false);
    }
  };

  if (threads.isLoading) return <PageLoader fullScreen={false} />;
  if (threads.isError || !threads.data) {
    return <ErrorState message={tc.loadFailed} retryLabel={tm.retry} onRetry={() => void threads.refetch()} />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {ordered.length === 0 ? (
        <EmptyState icon={MessageSquare} title={tc.empty} description={canReview ? tc.emptyDescription : undefined} />
      ) : (
        ordered.map((thread) => <ThreadCard key={thread.id} thread={thread} showLocation canReply={canReview} onReply={onReply} />)
      )}

      {canReview && (
        <div className="space-y-2 rounded-lg border p-3">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={tc.newCommentPlaceholder}
            aria-label={tc.newComment}
            rows={4}
          />
          <div className="flex justify-end">
            <Button disabled={body.trim() === '' || sending} onClick={() => void send()}>
              {tc.send}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
