import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Loader2, UserRoundCog } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { ReviewItem, ReviewType, SentReview } from '@weldsuite/app-api-client/domains/flow-approvals';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useMyReviews, useReviewsDone, useReviewsSent } from '@/hooks/queries/use-flow-approvals-queries';
import { useMemberNames } from '@/app/weldflow/_approvals/use-member-names';
import { DelegationDialog } from './_components/delegation-dialog';
import { ReviewDetail } from './_components/review-detail';
import { ReviewBuckets, ReviewFlatList, SentList } from './_components/review-list';

type View = 'mine' | 'sent' | 'done';
const VIEWS: readonly View[] = ['mine', 'sent', 'done'];
const TYPES: readonly ReviewType[] = [
  'change_request',
  'risk_acceptance',
  'decision',
  'deliverable',
  'gate',
  'project_request',
  'project_close',
  'timesheet',
];

function Message({ text, action }: Readonly<{ text: string; action?: { label: string; onClick: () => void } }>) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
      <p>{text}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

type MyReviews = ReturnType<typeof useMyReviews>['data'];

function selectableReviews(view: View, reviews: MyReviews, doneItems: ReviewItem[]): ReviewItem[] {
  if (view === 'done') return doneItems;
  if (view !== 'mine') return [];
  return [...(reviews?.groups.overdue ?? []), ...(reviews?.groups.this_week ?? []), ...(reviews?.groups.later ?? [])];
}

interface ListQuery {
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
}

interface ReviewListBodyProps {
  view: View;
  state: ListQuery;
  reviews: MyReviews;
  sentItems: SentReview[];
  doneItems: ReviewItem[];
  filtered: boolean;
  selectedId: string | null;
  nameOf: (userId: string | null | undefined) => string;
  onSelect: (id: string) => void;
}

function ReviewListBody({ view, state, reviews, sentItems, doneItems, filtered, selectedId, nameOf, onSelect }: Readonly<ReviewListBodyProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.reviews;
  if (state.isLoading) {
    return (
      <div className="flex justify-center py-16" role="status">
        <Loader2 className="animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (state.isError) {
    return <Message text={t.flowApprovals.common.loadFailed} action={{ label: t.flowApprovals.common.retry, onClick: () => void state.refetch() }} />;
  }
  if (view === 'mine') {
    return reviews && reviews.total > 0 ? (
      <ReviewBuckets groups={reviews.groups} selectedId={selectedId} nameOf={nameOf} onSelect={onSelect} />
    ) : (
      <Message text={filtered ? copy.emptyFiltered : copy.empty} />
    );
  }
  if (view === 'sent') {
    return sentItems.length > 0 ? <SentList items={sentItems} nameOf={nameOf} /> : <Message text={copy.emptySent} />;
  }
  return doneItems.length > 0 ? (
    <ReviewFlatList reviews={doneItems} selectedId={selectedId} nameOf={nameOf} onSelect={onSelect} />
  ) : (
    <Message text={copy.emptyDone} />
  );
}

interface TypeFilterProps {
  view: View;
  type: ReviewType | undefined;
  reviews: MyReviews;
  onChange: (type: ReviewType | undefined) => void;
}

function TypeFilter({ view, type, reviews, onChange }: Readonly<TypeFilterProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.reviews;
  const showCounts = view === 'mine' && reviews;
  const total = showCounts ? Object.values(reviews.counts).reduce((sum, count) => sum + count, 0) : 0;
  return (
    <div className="flex flex-wrap gap-1.5 border-b px-4 py-2" role="group" aria-label={copy.all}>
      <button
        type="button"
        aria-pressed={!type}
        onClick={() => onChange(undefined)}
        className={cn('rounded-full border px-3 py-1 text-xs', !type ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
      >
        {copy.all}
        {showCounts ? ` ${total}` : ''}
      </button>
      {TYPES.filter((candidate) => view !== 'mine' || candidate === type || (reviews?.counts[candidate] ?? 0) > 0).map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={type === candidate}
          onClick={() => onChange(type === candidate ? undefined : candidate)}
          className={cn('rounded-full border px-3 py-1 text-xs', type === candidate ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
        >
          {copy.types[candidate]}
          {view === 'mine' && reviews?.counts[candidate] ? ` ${reviews.counts[candidate]}` : ''}
        </button>
      ))}
    </div>
  );
}

/** My reviews: everything waiting for the caller's answer, what they sent and what they answered. */
export default function MyReviewsPage() {
  const { t } = useI18n();
  const copy = t.flowApprovals.reviews;
  const { userId } = useAuth();
  const { members, nameOf } = useMemberNames();
  const [view, setView] = useState<View>('mine');
  const [type, setType] = useState<ReviewType | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delegating, setDelegating] = useState(false);

  const mine = useMyReviews(type ? { type } : {});
  const sent = useReviewsSent(type ? { type } : {}, view === 'sent');
  const done = useReviewsDone(type ? { type } : {}, view === 'done');

  const reviews = mine.data;
  const doneItems = useMemo(() => done.data?.pages.flatMap((page) => page.data) ?? [], [done.data]);
  const sentItems = useMemo(() => sent.data?.pages.flatMap((page) => page.data) ?? [], [sent.data]);
  const selectable = selectableReviews(view, reviews, doneItems);
  const selected = selectable.find((review) => review.id === selectedId) ?? null;

  const active = { mine, sent, done }[view];

  const list = (
    <ReviewListBody
      view={view}
      state={active}
      reviews={reviews}
      sentItems={sentItems}
      doneItems={doneItems}
      filtered={Boolean(type)}
      selectedId={selectedId}
      nameOf={nameOf}
      onSelect={setSelectedId}
    />
  );
  const paged = { mine: null, sent, done }[view];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="my-reviews">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{t.flowApprovals.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        <div role="tablist" className="flex rounded-md border p-0.5">
          {VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={view === candidate}
              onClick={() => {
                setView(candidate);
                setSelectedId(null);
              }}
              className={cn('rounded px-3 py-1 text-sm', view === candidate ? 'bg-muted font-medium' : 'text-muted-foreground')}
            >
              {copy.views[candidate]}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setDelegating(true)}>
          <UserRoundCog aria-hidden />
          {copy.delegate}
        </Button>
      </div>

      <TypeFilter view={view} type={type} reviews={reviews} onChange={setType} />

      <div className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 w-full overflow-y-auto lg:w-[26rem] lg:shrink-0 lg:border-r', selected && 'hidden lg:block')}>
          {list}
          {paged?.hasNextPage ? (
            <div className="flex justify-center p-3">
              <Button type="button" variant="outline" size="sm" disabled={paged.isFetchingNextPage} onClick={() => void paged.fetchNextPage()}>
                {t.flowApprovals.common.loadMore}
              </Button>
            </div>
          ) : null}
        </div>
        <div className={cn('min-h-0 flex-1', !selected && 'hidden lg:block')}>
          {selected ? (
            <ReviewDetail review={selected} nameOf={nameOf} readOnly={view === 'done'} onClose={() => setSelectedId(null)} />
          ) : (
            <Message text={copy.selectReview} />
          )}
        </div>
      </div>

      <DelegationDialog open={delegating} onOpenChange={setDelegating} members={members} currentUserId={userId} nameOf={nameOf} />
    </div>
  );
}
