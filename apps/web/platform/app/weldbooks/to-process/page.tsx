import { CheckCircle2, Hourglass } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageColumn } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { isTodoAvailable, useTodoSummary } from '@/hooks/queries/use-weldbooks-todo-queries';
import { TODO_KINDS, type TodoKind, type TodoKindSummary } from '@/lib/api/domains/weldbooks';
import { isTimeBillingAvailable } from '@/hooks/queries/use-weldbooks-time-billing-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { TodoCard } from './todo-card';

/** The kinds that have something to do, most urgent first; a kind this build does not know is left out. */
export function visibleTodoKinds(
  kinds: Partial<Record<TodoKind, TodoKindSummary>> | undefined,
): Array<[TodoKind, TodoKindSummary]> {
  const out: Array<[TodoKind, TodoKindSummary]> = [];
  for (const kind of TODO_KINDS) {
    const summary = kinds?.[kind];
    if (summary && summary.count > 0) out.push([kind, summary]);
  }
  return out;
}

/**
 * Everything in the books that needs a person: one card per kind with its
 * count, amount, first items and one action. The work comes to you; the page
 * is the place to start (and to end) a working session.
 */
export default function ToProcessPage() {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  // Items open as stacked panels over this page, deep-linked with `?stack=`.
  useObjectPanelUrlSync('/weldbooks/to-process');
  const summary = useTodoSummary();
  const canReadTime = useCan('time:read');
  // Hours not invoiced yet are work too: the page that lists them is one click away (Rust only, `books-time-billing`).
  const showUnbilled = isTimeBillingAvailable() && canReadTime;

  // The Rust backend only (`books-todo`); the route guard shows the same page for a direct URL.
  if (!isTodoAvailable()) return <EditionUnavailablePage />;

  let body;
  if (summary.isError && !summary.data) {
    body = <ErrorState message={copy.loadFailed} onRetry={() => void summary.refetch()} />;
  } else if (!summary.data) {
    body = <PageLoader fullScreen={false} />;
  } else {
    const cards = visibleTodoKinds(summary.data.kinds);
    body =
      cards.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={copy.emptyTitle} description={copy.emptyDescription} />
      ) : (
        <ul className="grid items-start gap-4 lg:grid-cols-2">
          {cards.map(([kind, kindSummary]) => (
            <li key={kind} className="min-w-0">
              <TodoCard kind={kind} summary={kindSummary} />
            </li>
          ))}
        </ul>
      );
  }

  return (
    <PageColumn className="space-y-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
        {showUnbilled ? (
          <p className="pt-1">
            <Link
              href="/weldbooks/time/unbilled"
              className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
            >
              <Hourglass className="size-4" aria-hidden="true" />
              {t.weldbooksContactPage.menu.unbilledTime}
            </Link>
          </p>
        ) : null}
      </header>
      {body}
    </PageColumn>
  );
}
