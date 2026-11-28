/**
 * Questions (WeldBooks → Accountant, edition feature `books-questions`): the
 * questions asked on invoices, bills, bank lines, documents, VAT returns and
 * contacts, with their status. Filters (status, asked to me or anyone, the kind
 * of record) live in the address, and the list pages by the server's cursor.
 * A row opens the record on its Chat tab, where the thread is.
 */

import { MessageCircleQuestion } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  BOOKS_RECORD_CHAT_TYPES,
  QUESTION_STATUSES,
  type BooksRecordChatType,
  type QuestionStatus,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageColumn } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { QuestionStatusChip } from '@/components/accounting/questions/question-status';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { isQuestionsAvailable, useInfiniteQuestions } from '@/hooks/queries/use-weldbooks-questions-queries';
import type { Question } from '@/lib/api/domains/weldbooks-questions';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { questionAnswerTarget } from '../to-process/todo-targets';

export interface QuestionsSearch {
  /** A status, or `all` for any. Open when absent. */
  status?: string;
  /** `me` or `any`. Anyone for a member who books, else me, when absent. */
  askedTo?: string;
  /** A record type. Any record when absent. */
  type?: string;
}

const ANY_STATUS = 'all';

function statusFilter(value: string | undefined): QuestionStatus | undefined {
  if (value === ANY_STATUS) return undefined;
  if ((QUESTION_STATUSES as readonly string[]).includes(value ?? '')) return value as QuestionStatus;
  return 'open';
}

function askedToFilter(value: string | undefined, accountant: boolean): 'me' | 'any' {
  if (value === 'me' || value === 'any') return value;
  return accountant ? 'any' : 'me';
}

/** The filters the address asks for, as the API takes them; a value this build does not know is ignored. */
export function questionFilters(
  search: QuestionsSearch,
  accountant: boolean,
): { status: QuestionStatus | undefined; askedTo: 'me' | 'any'; recordType: BooksRecordChatType | undefined } {
  const status = statusFilter(search.status);
  const askedTo = askedToFilter(search.askedTo, accountant);
  const recordType = (BOOKS_RECORD_CHAT_TYPES as readonly string[]).includes(search.type ?? '')
    ? (search.type as BooksRecordChatType)
    : undefined;
  return { status, askedTo, recordType };
}

function QuestionListRow({ question }: Readonly<{ question: Question }>) {
  const { t } = useI18n();
  const tl = t.weldbooksQuestions.list;
  const router = useRouter();
  const { open } = useObjectPanel();
  const { formatDate } = useWeldbooksFormat();
  const record = t.weldbooksQuestions.records[question.recordType];

  const openChat = () => {
    const target = questionAnswerTarget(question);
    if (target.kind === 'panel') open({ type: target.type, id: target.id, initialTab: target.initialTab, stack: true });
    else router.push(target.href);
  };

  const place = [record, question.recordTitle].filter(Boolean).join(' · ');
  const asker = tl.askedBy.replace('{name}', question.askedBy.name ?? '—');

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3" data-testid="question-list-row" data-question-id={question.id}>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <QuestionStatusChip status={question.status} />
          <span className="truncate">{place}</span>
        </span>
        <button
          type="button"
          onClick={openChat}
          aria-label={tl.row.replace('{record}', place).replace('{text}', question.text)}
          className="line-clamp-3 whitespace-pre-wrap break-words rounded-sm text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          data-testid="question-list-open"
        >
          {question.text}
        </button>
        <span className="text-xs text-muted-foreground">
          {asker} · {formatDate(question.createdAt)}
          {question.replyCount > 0 ? ` · ${plural(question.replyCount, tl.replies, getLocale())}` : ''}
        </span>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={openChat}>
        {tl.openChat}
      </Button>
    </li>
  );
}

export default function QuestionsPage() {
  const { t } = useI18n();
  const tl = t.weldbooksQuestions.list;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as QuestionsSearch;
  const { can } = usePermissions();
  // Records open as stacked panels over this page, deep-linked with `?stack=`.
  useObjectPanelUrlSync('/weldbooks/questions');

  const filters = questionFilters(search, can('journal:create'));
  const query = useInfiniteQuestions(filters, { enabled: isQuestionsAvailable() });

  // The Rust backend only (`books-questions`); the route guard shows the same page for a direct URL.
  if (!isQuestionsAvailable()) return <EditionUnavailablePage />;

  /** Changes one filter in the address; every other parameter (`?stack=` of the object panel) stays. */
  const setFilter = (patch: QuestionsSearch) => void navigate({ to: '/weldbooks/questions', search: { ...search, ...patch } });

  const statusValue = filters.status ?? ANY_STATUS;
  const items = query.data?.items ?? [];

  let body;
  if (query.isError && !query.data) {
    body = <ErrorState message={tl.loadFailed} onRetry={() => void query.refetch()} />;
  } else if (!query.data) {
    body = <PageLoader fullScreen={false} />;
  } else if (items.length === 0) {
    body = <EmptyState icon={MessageCircleQuestion} title={tl.emptyTitle} description={tl.emptyDescription} />;
  } else {
    body = (
      <>
        <p className="text-sm text-muted-foreground" role="status" data-testid="questions-count">
          {plural(query.data.totalCount, tl.count, getLocale())}
        </p>
        <ul className="divide-y" data-testid="questions-list">
          {items.map((question) => (
            <QuestionListRow key={question.id} question={question} />
          ))}
        </ul>
        {query.hasNextPage ? (
          <div className="pt-2">
            <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchingNextPage ? tl.loadingMore : tl.loadMore}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <PageColumn className="space-y-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">{tl.title}</h1>
        <p className="text-sm text-muted-foreground">{tl.description}</p>
      </header>

      <div role="group" aria-label={tl.filtersLabel} className="flex flex-wrap items-center gap-2" data-testid="questions-filters">
        <FilterSelect
          ariaLabel={tl.statusLabel}
          value={statusValue === ANY_STATUS ? undefined : statusValue}
          onChange={(next) => setFilter({ status: next ?? ANY_STATUS })}
          allLabel={tl.statusAll}
          options={QUESTION_STATUSES.map((status) => ({ value: status, label: t.weldbooksQuestions.status[status] }))}
        />
        <FilterSelect
          ariaLabel={tl.askedToLabel}
          value={filters.askedTo === 'me' ? 'me' : undefined}
          onChange={(next) => setFilter({ askedTo: next ?? 'any' })}
          allLabel={tl.askedToAny}
          options={[{ value: 'me', label: tl.askedToMe }]}
        />
        <FilterSelect
          ariaLabel={tl.recordTypeLabel}
          value={filters.recordType}
          onChange={(next) => setFilter({ type: next })}
          allLabel={tl.recordTypeAll}
          options={BOOKS_RECORD_CHAT_TYPES.map((type) => ({ value: type, label: t.weldbooksQuestions.recordGroups[type] }))}
        />
      </div>

      {body}
    </PageColumn>
  );
}
