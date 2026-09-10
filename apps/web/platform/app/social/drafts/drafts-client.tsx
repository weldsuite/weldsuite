import { useMemo, useState } from 'react';
import { Loader2, Edit, Trash2, Zap, FileText, ImageIcon, Film } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  useSocialPosts,
  useSocialAccounts,
  useSocialMedia,
  useDeleteSocialPost,
  usePublishSocialPost,
} from '@/hooks/queries/use-social-queries';
import { ComposerDialog } from '@/app/social/components/composer-dialog';
import { SocialPlatformIcon } from '@/components/social/social-platform-icon';
import type { SocialAccount, SocialMedia, SocialPost } from '@weldsuite/app-api-client/domains/social';

// Composer still reads `accountIds`; the API stores targets as `targetAccountIds`.
type DraftPost = SocialPost & { accountIds?: string[] };

function postTargetIds(post: DraftPost): string[] {
  return post.targetAccountIds?.length
    ? post.targetAccountIds
    : (post.accountIds ?? []);
}

function DraftMediaThumb({
  media,
  extraCount,
}: {
  media: SocialMedia | undefined;
  extraCount: number;
}) {
  const src = media?.thumbnailUrl || media?.url || undefined;
  const isVideo = media?.mediaType === 'video';

  return (
    <div className="relative h-28 w-full shrink-0 overflow-hidden bg-muted sm:h-auto sm:w-32 sm:self-stretch">
      {src ? (
        <img
          src={src}
          alt={media?.altText || media?.fileName || ''}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full min-h-28 w-full items-center justify-center text-muted-foreground/40">
          <ImageIcon className="h-8 w-8" />
        </div>
      )}
      {isVideo && src && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25">
          <Film className="h-6 w-6 text-white drop-shadow" />
        </div>
      )}
      {extraCount > 0 && (
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
          +{extraCount}
        </span>
      )}
    </div>
  );
}

function PlatformTargets({
  accounts,
  platformLabels,
  emptyLabel,
}: {
  accounts: SocialAccount[];
  platformLabels: Record<string, string>;
  emptyLabel: string;
}) {
  if (accounts.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">{emptyLabel}</span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {accounts.map((account) => {
        const label =
          account.username
            ? `@${account.username}`
            : account.name || platformLabels[account.platform] || account.platform;
        return (
          <Tooltip key={account.id}>
            <TooltipTrigger asChild>
              <span className="inline-flex max-w-[11rem] items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
                <SocialPlatformIcon platform={account.platform} colored className="h-3.5 w-3.5" />
                <span className="truncate">{label}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {platformLabels[account.platform] || account.platform}
              {account.name ? ` · ${account.name}` : ''}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function DraftsClient() {
  const { t } = useI18n();
  const [composeOpen, setComposeOpen] = useState(false);
  const [editPost, setEditPost] = useState<DraftPost | null>(null);

  const { data, isLoading } = useSocialPosts({ status: 'draft' });
  const { data: accountsData } = useSocialAccounts();
  const { data: mediaData } = useSocialMedia();
  const deletePost = useDeleteSocialPost();
  const publishPost = usePublishSocialPost();

  const posts = (data?.data || []) as DraftPost[];
  const accountsById = useMemo(() => {
    const map = new Map<string, SocialAccount>();
    for (const account of accountsData?.data || []) {
      map.set(account.id, account);
    }
    return map;
  }, [accountsData]);
  const mediaById = useMemo(() => {
    const map = new Map<string, SocialMedia>();
    for (const item of mediaData?.data || []) {
      map.set(item.id, item);
    }
    return map;
  }, [mediaData]);

  const platformLabels = t.social.accounts.platforms as Record<string, string>;

  const openEdit = (post: DraftPost) => {
    setEditPost({
      ...post,
      accountIds: postTargetIds(post),
    });
    setComposeOpen(true);
  };

  const openCreate = () => {
    setEditPost(null);
    setComposeOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t.social.posts.drafts}</h1>
        <Button onClick={openCreate}>{t.social.posts.newPost}</Button>
      </div>

      {posts.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.posts.noPosts}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => {
            const targetIds = postTargetIds(post);
            const targets = targetIds
              .map((id) => accountsById.get(id))
              .filter((a): a is SocialAccount => !!a);
            const mediaIds = post.mediaIds ?? [];
            const firstMedia = mediaIds[0] ? mediaById.get(mediaIds[0]) : undefined;
            const extraMedia = Math.max(0, mediaIds.length - 1);

            return (
              <Card key={post.id} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex flex-col sm:flex-row">
                    <DraftMediaThumb media={firstMedia} extraCount={extraMedia} />

                    <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
                      <PlatformTargets
                        accounts={targets}
                        platformLabels={platformLabels}
                        emptyLabel={t.social.accounts.noAccounts}
                      />

                      {post.title ? (
                        <p className="truncate text-sm font-medium">{post.title}</p>
                      ) : null}

                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {post.content || '—'}
                      </p>

                      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                        <span className="text-xs text-muted-foreground">
                          {post.createdAt
                            ? formatDate(new Date(post.createdAt), 'MMM d, yyyy')
                            : ''}
                        </span>

                        <div className="flex shrink-0 gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="sm" variant="ghost" onClick={() => openEdit(post)}>
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t.social.posts.editPost}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => publishPost.mutate(post.id)}
                                disabled={publishPost.isPending}
                              >
                                <Zap className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t.social.posts.publishNow}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                onClick={() => deletePost.mutate(post.id)}
                                disabled={deletePost.isPending}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t.social.posts.deletePost}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ComposerDialog
        open={composeOpen}
        onOpenChange={(v) => {
          setComposeOpen(v);
          if (!v) setEditPost(null);
        }}
        editPost={editPost}
      />
    </div>
  );
}
