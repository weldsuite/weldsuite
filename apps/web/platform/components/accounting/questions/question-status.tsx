/**
 * The status of a question (open, answered, resolved) as a chip, and the strip
 * under a question's first message in its chat: the chip, who it was asked to
 * and "Mark resolved" / "Re-open". A question is the first message of a thread
 * whose `metadata.question` carries the status (ADR BOOKS-015).
 */

import { CheckCircle2, CircleDot, MessageCircleReply, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { QUESTION_STATUSES, type QuestionStatus } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { isQuestionsAvailable, useSetQuestionStatus } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useI18n } from '@/lib/i18n/provider';

const STATUS_TONE: Record<QuestionStatus, SoftTone> = {
  open: 'warning',
  answered: 'success',
  resolved: 'neutral',
};

const STATUS_ICON = {
  open: CircleDot,
  answered: MessageCircleReply,
  resolved: CheckCircle2,
} as const;

/** The state of a question as a soft badge. The word carries the meaning, not the colour. */
export function QuestionStatusChip({ status }: Readonly<{ status: QuestionStatus }>) {
  const { t } = useI18n();
  const Icon = STATUS_ICON[status];
  return (
    <SoftBadge tone={STATUS_TONE[status]} data-testid="question-status" data-status={status} className="gap-1">
      <Icon className="size-3" aria-hidden />
      {t.weldbooksQuestions.status[status]}
    </SoftBadge>
  );
}

/** What a message says about being a question, or null for an ordinary message. */
export function questionOfMessage(message: {
  parentId?: string;
  metadata?: unknown;
}): { status: QuestionStatus; askedTo: string[] } | null {
  if (message.parentId) return null;
  const question = (message.metadata as { question?: { status?: unknown; askedTo?: unknown } } | null | undefined)
    ?.question;
  if (!question) return null;
  const status = (QUESTION_STATUSES as readonly unknown[]).includes(question.status)
    ? (question.status as QuestionStatus)
    : 'open';
  const askedTo = Array.isArray(question.askedTo) ? question.askedTo.filter((id): id is string => typeof id === 'string') : [];
  return { status, askedTo };
}

interface QuestionBarMessage {
  id: string;
  parentId?: string;
  metadata?: unknown;
  threadReplyCount?: number;
}

function QuestionBar({
  message,
  channelId,
  membersMap,
  question,
}: Readonly<{
  message: QuestionBarMessage;
  channelId: string;
  membersMap?: Map<string, string>;
  question: { status: QuestionStatus; askedTo: string[] };
}>) {
  const { t } = useI18n();
  const tq = t.weldbooksQuestions.thread;
  const { can } = usePermissions();
  const canWrite = can('messages:create');
  const setStatus = useSetQuestionStatus();

  const names = question.askedTo.map((id) => membersMap?.get(id)).filter((name): name is string => !!name);
  const askedTo = names.length > 0 ? tq.askedTo.replace('{names}', names.join(', ')) : tq.askedToAll;
  const resolved = question.status === 'resolved';

  const change = (next: QuestionStatus) =>
    setStatus.mutate(
      { messageId: message.id, channelId, status: next },
      {
        onSuccess: () => toast.success(tq.updated),
        onError: (error) => toast.error(tq.updateFailed, { description: error instanceof Error ? error.message : undefined }),
      },
    );

  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-testid="question-bar"
    >
      <QuestionStatusChip status={question.status} />
      <span className="min-w-0 truncate">{askedTo}</span>
      {canWrite ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={setStatus.isPending}
          onClick={() => change(resolved ? 'open' : 'resolved')}
          data-testid={resolved ? 'question-reopen' : 'question-resolve'}
        >
          {resolved ? <RotateCcw className="size-3" aria-hidden /> : <CheckCircle2 className="size-3" aria-hidden />}
          {resolved ? tq.reopen : tq.markResolved}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The strip under a question in its chat. Nothing for an ordinary message (no
 * hooks run for it) and nothing where the edition has no questions.
 */
export function MessageQuestionBar({
  message,
  channelId,
  membersMap,
}: Readonly<{ message: QuestionBarMessage; channelId: string; membersMap?: Map<string, string> }>) {
  const question = isQuestionsAvailable() ? questionOfMessage(message) : null;
  if (!question) return null;
  return <QuestionBar message={message} channelId={channelId} membersMap={membersMap} question={question} />;
}
