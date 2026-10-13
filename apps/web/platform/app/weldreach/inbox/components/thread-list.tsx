/** The left pane of the inbox: one row per conversation, unread ones in bold. */

import { useEffect, useRef } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachThreadSummary } from '@weldsuite/app-api-client/schemas/reach';
import { cn } from '@/lib/utils';
import { InboundKindBadge, ReplyLabelBadge } from '@/app/weldreach/components/engage/badges';
import { RelativeTime, personName } from '@/app/weldreach/components/engage/format';
import { isHandled, isUnread } from '../lib/thread-state';

/**
 * The summary's `lastInbound` is meant to carry `labelSource` too, so the row can
 * mark an AI label; until the contract picks it up the field is read when present.
 */
type LastInbound = ReachThreadSummary['lastInbound'] & {
  labelSource?: 'ai' | 'user' | 'rule' | null;
};

export function ThreadList({
  threads,
  selectedKey,
  hasMore,
  isLoadingMore,
  onSelect,
  onLoadMore,
}: Readonly<{
  threads: ReachThreadSummary[];
  selectedKey: string | undefined;
  hasMore: boolean;
  isLoadingMore: boolean;
  onSelect: (threadKey: string) => void;
  onLoadMore: () => void;
}>) {
  const t = useTranslations();
  const sentinel = useRef<HTMLLIElement>(null);

  // Cursor pagination: ask for the next page when the end of the list scrolls into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isLoadingMore) onLoadMore();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore, threads.length]);

  return (
    <ul className="divide-y">
      {threads.map((thread) => {
        const unread = isUnread(thread);
        const handled = isHandled(thread);
        const name = thread.prospect ? personName(thread.prospect) : null;
        const who = name ?? thread.prospect?.email ?? t('reachEngage.inbox.unknownSender');
        const lastInbound: LastInbound = thread.lastInbound;

        return (
          <li key={thread.threadKey}>
            <button
              type="button"
              onClick={() => onSelect(thread.threadKey)}
              aria-current={thread.threadKey === selectedKey ? 'true' : undefined}
              className={cn(
                'flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                thread.threadKey === selectedKey && 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  unread ? 'bg-primary' : 'bg-transparent',
                )}
                aria-label={unread ? t('reachEngage.inbox.unread') : undefined}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
                    {who}
                  </span>
                  <RelativeTime
                    value={lastInbound.receivedAt}
                    className="shrink-0 text-xs text-muted-foreground"
                  />
                </span>
                {thread.prospect?.companyName && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {thread.prospect.companyName}
                  </span>
                )}
                <span className={cn('block truncate text-sm', unread ? 'font-medium' : 'text-muted-foreground')}>
                  {lastInbound.subject ?? t('reachEngage.inbox.noSubject')}
                </span>
                {lastInbound.snippet && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{lastInbound.snippet}</span>
                )}
                <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {lastInbound.label && lastInbound.label !== 'unclassified' && (
                    <ReplyLabelBadge label={lastInbound.label} source={lastInbound.labelSource} />
                  )}
                  <InboundKindBadge kind={lastInbound.kind} />
                  {handled && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {t('reachEngage.inbox.handled')}
                    </span>
                  )}
                  {thread.campaign && (
                    <span className="truncate text-xs text-muted-foreground">{thread.campaign.name}</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
      {hasMore && (
        <li ref={sentinel} className="flex justify-center py-4">
          {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </li>
      )}
    </ul>
  );
}
