/**
 * The Questions card of the To process page (edition feature `books-questions`):
 * the open questions the accountant asked, each with who asked, what it is
 * about, the text, and the two ways to answer: "Answer" (the record's chat
 * thread) and, for a bank line, "Add a document" (the processing view's receipt
 * flow for that line). An accountant sees every open question of the entity
 * here; an owner sees those asked to them.
 */

import { useId, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardFooter, CardHeader } from '@weldsuite/ui/components/card';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useObjectPanel } from '@/components/object-panel';
import { useMemberAvatar } from '@/hooks/use-member-avatar';
import { TODO_TOP_LIMIT } from '@/hooks/queries/use-weldbooks-todo-queries';
import { useInfiniteQuestions } from '@/hooks/queries/use-weldbooks-questions-queries';
import type { TodoKindSummary } from '@/lib/api/domains/weldbooks';
import type { Question } from '@/lib/api/domains/weldbooks-questions';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { questionAnswerTarget, questionReceiptHref } from './todo-targets';

/** Up to two initials of a name ("Mila Jansen" is "MJ"). */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** One open question: asker, record, text and its two actions. */
export function QuestionRow({ question }: Readonly<{ question: Question }>) {
  const { t } = useI18n();
  const tc = t.weldbooksQuestions.card;
  const router = useRouter();
  const { open } = useObjectPanel();
  const { formatDate } = useWeldbooksFormat();
  const picture = useMemberAvatar(question.askedBy.id);
  const name = question.askedBy.name || tc.unknownAsker;
  const record = t.weldbooksQuestions.records[question.recordType];
  const receiptHref = questionReceiptHref(question);
  // Every row has an Answer: the question's text says which one this is.
  const textId = useId();

  const answer = () => {
    const target = questionAnswerTarget(question);
    if (target.kind === 'panel') open({ type: target.type, id: target.id, initialTab: target.initialTab, stack: true });
    else router.push(target.href);
  };

  const place = [tc.on.replace('{record}', record), question.recordTitle, formatDate(question.createdAt)]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="space-y-3" data-testid="question-row" data-question-id={question.id}>
      <div className="flex gap-3 rounded-[10px] bg-muted/50 px-3.5 py-3">
        <Avatar className="size-8" data-testid="question-avatar">
          {picture ? <AvatarImage src={picture} /> : null}
          <AvatarFallback className="bg-blue-100 text-[13px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {initialsOf(name)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">{name}</span> · {place}
          </span>
          <span id={textId} className="whitespace-pre-wrap break-words text-sm">
            {question.text}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={answer} aria-describedby={textId} data-testid="question-answer">
          {tc.answer}
        </Button>
        {receiptHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={receiptHref} aria-describedby={textId} data-testid="question-add-document">
              {tc.addDocument}
            </Link>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function QuestionsCard({ summary }: Readonly<{ summary: TodoKindSummary }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const tc = t.weldbooksQuestions.card;
  const { can } = usePermissions();
  const [expanded, setExpanded] = useState(false);
  // A member who books sees every open question of the entity; an owner the ones asked to them.
  const askedTo = can('journal:create') ? 'any' : 'me';
  const query = useInfiniteQuestions({ status: 'open', askedTo });
  const items = query.data?.items ?? [];
  const shown = expanded ? items : items.slice(0, TODO_TOP_LIMIT);
  const canExpand = summary.count > TODO_TOP_LIMIT;

  let body;
  if (query.isError && !query.data) body = <ErrorState message={copy.listFailed} onRetry={() => void query.refetch()} />;
  else if (!query.data) body = <InlineSpinner />;
  else {
    body = (
      <>
        <ul className="space-y-5">
          {shown.map((question) => (
            <QuestionRow key={question.id} question={question} />
          ))}
        </ul>
        {expanded && query.hasNextPage ? (
          <div className="pt-3">
            <Button variant="ghost" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <article
      aria-labelledby="todo-questions"
      className="@container/todo min-w-0"
      data-testid="todo-card-questions"
      data-kind="questions"
    >
      <Card className="h-full gap-4 py-5">
        <CardHeader className="gap-1">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-muted" aria-hidden>
              <MessageCircleQuestion className="size-[18px]" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 id="todo-questions" className="truncate text-base font-semibold">
                {copy.kinds.questions.title}
              </h2>
              <span className="text-[13px] text-muted-foreground">{tc.subtitle}</span>
            </div>
            <span
              className="grid h-6 min-w-7 place-items-center rounded-xl bg-muted px-2 text-[13px] font-semibold tabular-nums"
              data-testid="todo-count"
            >
              {summary.count}
            </span>
          </div>
        </CardHeader>
        <CardContent>{body}</CardContent>
        <CardFooter className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/weldbooks/questions">{tc.viewAll}</Link>
          </Button>
          {canExpand ? (
            <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
              {expanded ? copy.showFewer : copy.showAll.replace('{count}', String(summary.count))}
              <span className="sr-only"> {copy.kinds.questions.title}</span>
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </article>
  );
}
