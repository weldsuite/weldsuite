/** The end of the conversation list: asks for the next page once it scrolls into view. */

import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';

export function LoadMoreSentinel({
  isLoadingMore,
  onLoadMore,
}: Readonly<{ isLoadingMore: boolean; onLoadMore: () => void }>) {
  const t = useTranslations();
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isLoadingMore) onLoadMore();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isLoadingMore, onLoadMore]);

  return (
    <div ref={sentinel} className="flex items-center justify-center py-4 text-xs text-muted-foreground">
      {isLoadingMore && (
        <>
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          {t('reachEngage.inbox.loadingMore')}
        </>
      )}
    </div>
  );
}
