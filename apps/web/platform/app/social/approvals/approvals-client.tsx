import { useState } from 'react';
import { Loader2, CheckCircle } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import {
  useSocialApprovals,
  useSocialPosts,
  useApproveSocialApproval,
  useRejectSocialApproval,
} from '@/hooks/queries/use-social-queries';
import type { SocialApproval, SocialPost } from '@weldsuite/app-api-client/domains/social';

// The backend also returns `submittedAt`, not yet reflected in the shared
// SocialApproval type.
type SocialApprovalWithSubmission = SocialApproval & { submittedAt?: string | null };

export function ApprovalsClient() {
  const { t } = useI18n();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: approvalsData, isLoading } = useSocialApprovals({ status: 'pending' });
  const { data: postsData } = useSocialPosts({});
  const approveApproval = useApproveSocialApproval();
  const rejectApproval = useRejectSocialApproval();

  const approvals = approvalsData?.data || [];
  const posts = postsData?.data || [];
  const busy = approveApproval.isPending || rejectApproval.isPending;

  const getPost = (postId: string) => posts.find((p: SocialPost) => p.id === postId);

  const handleApprove = async (id: string) => {
    try {
      const res = await approveApproval.mutateAsync({ id, decisionNotes: notes[id] });
      const scheduled = res.data?.scheduled;
      const scheduleError = res.data?.scheduleError;
      if (scheduled) {
        toast.success(t.social.messages.postScheduled);
      } else if (scheduleError) {
        toast.success(t.social.messages.postApproved);
        toast.error(scheduleError);
      } else {
        toast.success(t.social.messages.postApproved);
      }
    } catch {
      // ignore — mutation surfaces via toast elsewhere if wired
    }
  };

  const handleReject = async (id: string, revision: boolean) => {
    try {
      await rejectApproval.mutateAsync({
        id,
        decisionNotes: notes[id],
        rejectionReason: notes[id],
        revision,
      });
      if (revision) toast.success(t.social.queue.requestRevision);
      else toast.success(t.social.messages.postRejected);
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">{t.social.queue.pendingApprovals}</h1>

      {approvals.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <CheckCircle className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.queue.noPendingApprovals}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((approval: SocialApprovalWithSubmission) => {
            const post = getPost(approval.postId);
            return (
              <Card key={approval.id}>
                <CardContent className="p-4 space-y-3">
                  {/* Post preview */}
                  {post && (
                    <div className="bg-muted rounded p-3 space-y-1">
                      <p className="text-sm">{post.content || '—'}</p>
                      {post.scheduledAt && (
                        <p className="text-xs text-muted-foreground">
                          {t.social.posts.scheduledFor}:{' '}
                          {formatDate(new Date(post.scheduledAt), 'MMM d, yyyy HH:mm')}
                          {post.timezone ? ` (${post.timezone})` : ''}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{approval.status}</Badge>
                    {approval.submittedAt && (
                      <span>
                        {t.social.queue.submittedAt.replace('{time}', formatDate(new Date(approval.submittedAt), 'MMM d'))}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label>{t.social.queue.reviewNotes}</Label>
                    <Textarea
                      rows={2}
                      placeholder={t.social.queue.reviewNotes}
                      value={notes[approval.id] || ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [approval.id]: e.target.value }))}
                    />
                  </div>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleApprove(approval.id)}
                      disabled={busy}
                    >
                      {t.social.queue.approve}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleReject(approval.id, true)}
                      disabled={busy}
                    >
                      {t.social.queue.requestRevision}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleReject(approval.id, false)}
                      disabled={busy}
                    >
                      {t.social.queue.reject}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
