import { useBookmarks, useDeleteBookmark } from '@/hooks/queries/use-weldchat-queries';
import { Bookmark, X, Hash } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Link } from '@tanstack/react-router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export default function BookmarksPage() {
  const { t } = useI18n();
  const st = useTranslations();
  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.weldchat.bookmarks.savedItems },
  ]);
  const { data, isLoading } = useBookmarks();
  const { mutate: deleteBookmark } = useDeleteBookmark();
  const bookmarks = data?.data || [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Bookmark className="h-5 w-5" />
        <h2 className="font-semibold">{t.weldchat.bookmarks.savedItems}</h2>
        {bookmarks.length > 0 && (
          <span className="text-xs text-muted-foreground">({bookmarks.length})</span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="text-center text-muted-foreground py-8">
            {t.weldchat.bookmarks.loading}
          </div>
        )}
        {!isLoading && bookmarks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Bookmark className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm font-medium">{t.weldchat.bookmarks.noSavedItems}</p>
            <p className="text-xs mt-1">{t.weldchat.bookmarks.noSavedItemsHint}</p>
          </div>
        )}
        {bookmarks.map((bk: any) => (
          <div key={bk.id} className="group/bk px-4 py-3 hover:bg-muted/50 transition-colors border-b border-border/50">
            {bk.channelName && (
              <Link
                to="/weldchat/$channelId"
                params={{ channelId: bk.channelId }}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground font-medium hover:text-foreground transition-colors"
              >
                <Hash className="h-3 w-3" />
                {bk.channelName}
              </Link>
            )}
            <div className="flex items-start gap-3 mt-1">
              <Avatar className="h-8 w-8 flex-shrink-0 mt-0.5 !rounded-[10px]">
                {bk.messageAuthorAvatar && <AvatarImage src={bk.messageAuthorAvatar} className="!rounded-[10px]" />}
                <AvatarFallback className="text-xs !rounded-[10px]">
                  {(bk.messageAuthorName || '?')[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate">{bk.messageAuthorName}</span>
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">
                    {bk.messageCreatedAt && new Date(bk.messageCreatedAt).toLocaleDateString('en-US', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                    })}{' '}
                    {bk.messageCreatedAt && new Date(bk.messageCreatedAt).toLocaleTimeString([], {
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 ml-auto opacity-0 group-hover/bk:opacity-100 transition-opacity flex-shrink-0"
                    onClick={() => deleteBookmark(bk.id)}
                    title={t.weldchat.bookmarks.removeBookmark}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-sm text-foreground/90 mt-0.5 whitespace-pre-wrap break-words">
                  {bk.messageContent}
                </p>
                {bk.note && (
                  <p className="text-xs text-muted-foreground mt-1 italic">{bk.note}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
