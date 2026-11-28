/**
 * The "Ask a question" action of a WeldBooks record: a button that opens the
 * ask form. Shown only where the edition has questions (`books-questions`) and
 * to members who may write in a chat.
 */

import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import type { BooksRecordChatType } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { Button, type ButtonProps } from '@weldsuite/ui/components/button';
import { isQuestionsAvailable } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AskQuestionDialog } from './ask-question-dialog';

export interface AskQuestionButtonProps {
  recordType: BooksRecordChatType;
  recordId: string;
  /** The text the form starts with. */
  defaultText?: string;
  /** Replaces "Ask a question". */
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  testId?: string;
}

/** Whether this member can ask a question here: the edition has them and they may write. */
export function useCanAskQuestion(): boolean {
  const { can } = usePermissions();
  return isQuestionsAvailable() && can('messages:create');
}

export function AskQuestionButton({
  recordType,
  recordId,
  defaultText,
  label,
  variant = 'outline',
  size = 'sm',
  className,
  testId = 'ask-question',
}: Readonly<AskQuestionButtonProps>) {
  const { t } = useI18n();
  const canAsk = useCanAskQuestion();
  const [open, setOpen] = useState(false);
  if (!canAsk) return null;
  const record = t.weldbooksQuestions.records[recordType];
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        title={t.weldbooksQuestions.ask.actionHint.replace('{record}', record)}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        <MessageCircleQuestion className="size-4" aria-hidden />
        {label ?? t.weldbooksQuestions.ask.action}
      </Button>
      <AskQuestionDialog
        open={open}
        onOpenChange={setOpen}
        recordType={recordType}
        recordId={recordId}
        defaultText={defaultText}
      />
    </>
  );
}
