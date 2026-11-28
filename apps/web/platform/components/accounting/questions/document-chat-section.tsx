/**
 * The chat of an inbox document (edition feature `books-questions`). A document
 * has no panel, so its chat sits in a disclosure on the review screen and in
 * the documents dialog: closed it is one line with the "Ask a question" action,
 * open it is the record chat. The chat is only loaded once it is opened.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { isQuestionsAvailable } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AskQuestionButton } from './ask-question-button';
import { RecordQuestionChat } from './record-question-chat';

export function DocumentChatSection({ documentId, name }: Readonly<{ documentId: string; name?: string }>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!isQuestionsAvailable()) return null;
  return (
    <section className="rounded-lg border" data-testid="document-chat">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-expanded={open}
          aria-controls={`document-chat-${documentId}`}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          {t.weldbooksQuestions.chat.tab}
        </button>
        <AskQuestionButton recordType="accounting_document" recordId={documentId} testId="document-ask-question" />
      </div>
      {open ? (
        <div id={`document-chat-${documentId}`} className="flex h-80 min-h-0 flex-col border-t">
          <RecordQuestionChat recordType="accounting_document" recordId={documentId} name={name} />
        </div>
      ) : null}
    </section>
  );
}
