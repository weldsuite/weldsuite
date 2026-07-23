import { useState } from 'react';
import { Loader2, Edit, Trash2, Zap, FileText } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  useSocialPosts,
  useDeleteSocialPost,
  usePublishSocialPost,
} from '@/hooks/queries/use-social-queries';
import { ComposerDialog } from '@/app/social/components/composer-dialog';

export function DraftsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [composeOpen, setComposeOpen] = useState(false);
  const [editPost, setEditPost] = useState<any>(null);

  const { data, isLoading } = useSocialPosts({ status: 'draft' });
  const deletePost = useDeleteSocialPost();
  const publishPost = usePublishSocialPost();

  const posts = data?.data || [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">{t.social.posts.drafts}</h1>

      {posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <FileText className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.posts.noPosts}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post: any) => (
            <Card key={post.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm line-clamp-2">{post.content || '—'}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {post.createdAt ? formatDate(new Date(post.createdAt), 'MMM d, yyyy') : ''}
                      </span>
                      {post.accountIds?.length > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {st('sweep.miscA.socialDrafts.accountsCount', { count: post.accountIds.length })}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
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
                      onClick={() => publishPost.mutate(post.id)}
                    >
                      <Zap className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deletePost.mutate(post.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ComposerDialog
        open={composeOpen}
        onOpenChange={(v) => { setComposeOpen(v); if (!v) setEditPost(null); }}
        editPost={editPost}
      />
    </div>
  );
}
