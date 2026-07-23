import { useState } from 'react';
import { Loader2, Edit, RefreshCw, X, Zap } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import {
  useSocialPosts,
  useCancelSocialPost,
  usePublishSocialPost,
  useRescheduleSocialPost,
} from '@/hooks/queries/use-social-queries';
import { ComposerDialog } from '@/app/social/components/composer-dialog';

export function QueueClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [composeOpen, setComposeOpen] = useState(false);
  const [editPost, setEditPost] = useState<any>(null);
  const [reschedulePostId, setReschedulePostId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState('');

  const { data, isLoading } = useSocialPosts({ status: 'scheduled' });
  const cancelPost = useCancelSocialPost();
  const publishPost = usePublishSocialPost();
  const reschedulePost = useRescheduleSocialPost();

  const posts = data?.data || [];

  // Group by date
  const grouped: Record<string, any[]> = {};
  for (const post of posts) {
    const dateKey = post.scheduledAt
      ? formatDate(new Date(post.scheduledAt), 'PPP')
      : st('sweep.miscA.socialQueue.unknownDate');
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(post);
  }

  const handleReschedule = async (id: string) => {
    if (!rescheduleValue) return;
    await reschedulePost.mutateAsync({ id, scheduledAt: new Date(rescheduleValue).toISOString() });
    setReschedulePostId(null);
    setRescheduleValue('');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t.social.posts.scheduled}</h1>
        <Button onClick={() => { setEditPost(null); setComposeOpen(true); }}>
          {t.social.posts.newPost}
        </Button>
      </div>

      {posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <Loader2 className="h-6 w-6 opacity-20" />
          <p className="text-sm">{t.social.calendar.noScheduledPosts}</p>
        </div>
      ) : (
        Object.entries(grouped).map(([date, datePosts]) => (
          <div key={date}>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase mb-3">{date}</h2>
            <div className="space-y-3">
              {datePosts.map((post: any) => (
                <Card key={post.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm line-clamp-2">{post.content || '—'}</p>
                        {post.scheduledAt && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate(new Date(post.scheduledAt), 'h:mm a')}
                          </p>
                        )}
                        {post.accountIds?.length > 0 && (
                          <div className="flex gap-1 mt-2">
                            {post.accountIds.map((id: string) => (
                              <Badge key={id} variant="outline" className="text-xs">{id}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0 flex-wrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setEditPost(post); setComposeOpen(true); }}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setReschedulePostId(post.id);
                            setRescheduleValue('');
                          }}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cancelPost.mutate(post.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => publishPost.mutate(post.id)}
                        >
                          <Zap className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {reschedulePostId === post.id && (
                      <div className="mt-3 flex gap-2 items-center">
                        <Input
                          type="datetime-local"
                          value={rescheduleValue}
                          onChange={(e) => setRescheduleValue(e.target.value)}
                          className="flex-1"
                        />
                        <Button size="sm" onClick={() => handleReschedule(post.id)} disabled={!rescheduleValue}>
                          {st('sweep.miscA.socialQueue.save')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setReschedulePostId(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}

      <ComposerDialog
        open={composeOpen}
        onOpenChange={(v) => { setComposeOpen(v); if (!v) setEditPost(null); }}
        editPost={editPost}
      />
    </div>
  );
}
