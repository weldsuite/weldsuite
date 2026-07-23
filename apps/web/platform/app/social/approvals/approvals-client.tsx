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
  useUpdateSocialApproval,
} from '@/hooks/queries/use-social-queries';

export function ApprovalsClient() {
  const { t } = useI18n();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: approvalsData, isLoading } = useSocialApprovals({ status: 'pending' });
  const { data: postsData } = useSocialPosts({});
  const updateApproval = useUpdateSocialApproval();

  const approvals = approvalsData?.data || [];
  const posts = postsData?.data || [];

  const getPost = (postId: string) => posts.find((p: any) => p.id === postId);

  const handleAction = async (id: string, status: string) => {
    try {
      await updateApproval.mutateAsync({ id, status, decisionNotes: notes[id] });
      if (status === 'approved') toast.success(t.social.messages.postApproved);
      else if (status === 'rejected') toast.success(t.social.messages.postRejected);
      else toast.success(t.social.queue.requestRevision);
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
          {approvals.map((approval: any) => {
            const post = getPost(approval.postId);
            return (
              <Card key={approval.id}>
                <CardContent className="p-4 space-y-3">
                  {/* Post preview */}
                  {post && (
                    <div className="bg-muted rounded p-3">
                      <p className="text-sm">{post.content || '—'}</p>
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
                      onClick={() => handleAction(approval.id, 'approved')}
                      disabled={updateApproval.isPending}
                    >
                      {t.social.queue.approve}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAction(approval.id, 'revision_requested')}
                      disabled={updateApproval.isPending}
                    >
                      {t.social.queue.requestRevision}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleAction(approval.id, 'rejected')}
                      disabled={updateApproval.isPending}
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
