/**
 * The Chat tab of a WeldBooks record (invoice, bill, bank line, VAT return,
 * contact, inbox document): the record's chat, with an "Ask a question" bar
 * above it. Questions show in the chat as threads with a status chip.
 */

import type { BooksRecordChatType } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { EntityChat } from '@/components/entity-chat/entity-chat';
import { useI18n } from '@/lib/i18n/provider';
import { AskQuestionButton, useCanAskQuestion } from './ask-question-button';

export function RecordQuestionChat({
  recordType,
  recordId,
  name,
}: Readonly<{
  recordType: BooksRecordChatType;
  recordId: string;
  /** The record's name, for the chat before it has a channel. */
  name?: string;
}>) {
  const { t } = useI18n();
  const canAsk = useCanAskQuestion();
  return (
    <EntityChat
      entityType={recordType}
      entityId={recordId}
      fallbackName={name}
      hideHeader
      hideCallButtons
      headerSlot={
        canAsk ? (
          <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground">{t.weldbooksQuestions.chat.askHint}</span>
            <AskQuestionButton recordType={recordType} recordId={recordId} testId="chat-ask-question" />
          </div>
        ) : null
      }
    />
  );
}
