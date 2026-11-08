import { Languages } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import type { DeskConversation, DeskMessage } from '@/hooks/queries/use-desk-queries';
import {
  customerMessageIds,
  messageTranslationMetadata,
  useDeskConversationTranslations,
} from '@/hooks/queries/use-desk-translation-queries';
import {
  agentLocale,
  languageLabel,
  useDeskTranslationAvailable,
  useTranslateOn,
} from './translation-state';

interface MessageTranslationProps {
  conversation: DeskConversation;
  /** The whole thread: the translation query is keyed by the customer's messages. */
  messages: DeskMessage[];
  message: DeskMessage;
}

/**
 * Under a message in the timeline: a customer message's translation into the
 * agent's language while "Translate" is on (the original stays above it), or,
 * for a reply the agent sent translated, what they wrote. Internal only.
 */
export function MessageTranslation({ conversation, messages, message }: Readonly<MessageTranslationProps>) {
  const t = getTranslations('helpdesk').translation;
  const available = useDeskTranslationAvailable();
  const [on] = useTranslateOn(conversation.id);
  const isCustomer = message.authorType === 'visitor';
  const query = useDeskConversationTranslations(
    conversation.id,
    agentLocale(),
    customerMessageIds(messages),
    available && on && isCustomer,
  );

  const sent = messageTranslationMetadata(message);
  if (sent && available) {
    return (
      <div
        className="mt-1 max-w-full text-right text-xs text-muted-foreground whitespace-pre-wrap break-words"
        data-testid="desk-inbox-sent-original"
      >
        <span className="inline-flex items-center gap-1 font-medium">
          <Languages className="h-3 w-3" />
          {t.originalIn.replace('{language}', languageLabel(sent.sourceLocale))}
        </span>
        <p>{sent.original}</p>
      </div>
    );
  }

  if (!available || !on || !isCustomer) return null;
  const translation = query.data?.translations.find((item) => item.messageId === message.id);
  if (!translation) {
    return query.isFetching ? (
      <p className="mt-1 text-xs italic text-muted-foreground">{t.translating}</p>
    ) : null;
  }
  return (
    <div
      className="mt-1 max-w-full text-sm text-muted-foreground whitespace-pre-wrap break-words"
      data-testid="desk-inbox-message-translation"
    >
      <p>{translation.text}</p>
      <p className="mt-0.5 inline-flex items-center gap-1 text-[11px]">
        <Languages className="h-3 w-3" />
        {t.translatedFrom.replace('{language}', languageLabel(query.data?.language))}
      </p>
    </div>
  );
}
