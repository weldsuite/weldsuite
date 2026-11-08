/**
 * The WeldReach reply inbox, laid out like WeldMail's inbox: the shared
 * conversation list on the left (Filter for state, label, campaign and
 * mailbox; refreshed every 30 seconds), the open conversation on the right.
 * `?thread=<key>` makes a conversation linkable.
 */

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useRouter, useSearchParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { ConversationList } from '@/components/shared/conversation-list';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useReachThreads, useReachUnreadCount } from '@/hooks/queries/use-reach-inbox-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { errorMessage, useReachBreadcrumbs } from '@/app/weldreach/components/engage/kit';
import { InboxFilter, DEFAULT_INBOX_FILTER, countActiveFilters, type InboxFilterValue } from './components/inbox-filter';
import { LoadMoreSentinel } from './components/load-more-sentinel';
import { ThreadView } from './components/thread-view';
import { threadToConversationItem } from './lib/conversation-items';

function threadHref(threadKey: string): string {
  return `/weldreach/inbox?thread=${encodeURIComponent(threadKey)}`;
}

/** What the reading pane shows while no conversation is open: WeldMail's "Select a message". */
function NoConversationSelected({ unreadCount }: Readonly<{ unreadCount: number }>) {
  const t = useTranslations();
  const format = useReachFormat();

  return (
    <div className="hidden h-full w-full flex-col items-center justify-center px-6 text-center md:flex">
      <EmptyStateIllustration>
        {/* WeldReach logo as a mask, so it takes the theme colour instead of the brand pink */}
        <span
          aria-hidden="true"
          className="block aspect-[653/602] w-20 bg-muted-foreground/20 [mask:url(/assets/images/weldreach/icon.svg)_center/contain_no-repeat]"
        />
      </EmptyStateIllustration>
      <h3 className="mb-1.5 text-[15px] font-semibold text-foreground">{t('reachEngage.inbox.selectTitle')}</h3>
      <p className="max-w-[320px] text-sm leading-relaxed text-muted-foreground">
        {t('reachEngage.inbox.selectDescription')}
      </p>
      {unreadCount > 0 && (
        <p className="mt-4 text-sm font-medium text-foreground">
          {t(unreadCount === 1 ? 'reachEngage.inbox.newReply' : 'reachEngage.inbox.newReplies', {
            count: format.number(unreadCount),
          })}
        </p>
      )}
    </div>
  );
}

export default function ReachInboxPage() {
  const t = useTranslations();
  const router = useRouter();
  const { can } = usePermissions();
  const searchParams = useSearchParams();
  useReachBreadcrumbs({ label: t('reachEngage.inbox.title') });

  const threadKey = searchParams.get('thread') ?? undefined;
  const [filter, setFilter] = useState<InboxFilterValue>(DEFAULT_INBOX_FILTER);

  const threads = useReachThreads(filter);
  const unread = useReachUnreadCount({ enabled: can('reach_inbox:read') });
  const items = useMemo(
    () => threads.threads.map((thread) => threadToConversationItem(thread, t)),
    [threads.threads, t],
  );

  const error =
    threads.isError && threads.threads.length === 0
      ? errorMessage(threads.error, t('reachEngage.inbox.loadFailed'))
      : null;
  const emptyMessage =
    countActiveFilters(filter) === 0 ? t('reachEngage.inbox.emptyTitle') : t('reachEngage.inbox.noResultsTitle');
  const refreshLabel = t('reachEngage.inbox.refresh');

  const list = (
    <ConversationList
      items={items}
      selectedId={threadKey}
      getItemUrl={(item) => threadHref(item.id)}
      onItemClick={(item) => router.replace(threadHref(item.id))}
      filterContent={
        <>
          <InboxFilter value={filter} onChange={setFilter} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground shadow-none"
                aria-label={refreshLabel}
                disabled={threads.isFetching}
                onClick={() => void threads.refetch()}
              >
                <RefreshCw className={cn('h-4 w-4', threads.isFetching && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{refreshLabel}</TooltipContent>
          </Tooltip>
        </>
      }
      error={error}
      isLoading={threads.isLoading}
      emptyMessage={emptyMessage}
      footer={
        threads.hasNextPage ? (
          <LoadMoreSentinel
            isLoadingMore={threads.isFetchingNextPage}
            onLoadMore={() => void threads.fetchNextPage()}
          />
        ) : null
      }
    />
  );

  return (
    <ListDetailLayout list={list} isDetailSelected={Boolean(threadKey)}>
      {threadKey ? (
        <ThreadView key={threadKey} threadKey={threadKey} onBack={() => router.replace('/weldreach/inbox')} />
      ) : (
        <NoConversationSelected unreadCount={unread.data ?? 0} />
      )}
    </ListDetailLayout>
  );
}
