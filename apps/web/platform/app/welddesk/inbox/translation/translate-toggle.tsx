import { useEffect } from 'react';
import { toast } from 'sonner';
import { Languages } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import type { DeskConversation, DeskMessage } from '@/hooks/queries/use-desk-queries';
import {
  conversationLanguage,
  customerMessageIds,
  useDeskConversationTranslations,
} from '@/hooks/queries/use-desk-translation-queries';
import {
  agentLocale,
  languageLabel,
  sameLanguage,
  translationErrorMessage,
  useDeskTranslationAvailable,
  useTranslateOn,
} from './translation-state';

/**
 * The customer's language in the conversation header, and the toast when
 * translating fails. The switch itself is "Translate" in the header's "⋯"
 * menu (`TranslateMenuItem`); turning it on translates the customer's
 * messages into the agent's language under each message in the timeline.
 * Hidden where the edition has no AI.
 */
export function TranslateLanguageBadge({
  conversation,
}: Readonly<{ conversation: DeskConversation & { messages?: DeskMessage[] } }>) {
  const t = getTranslations('helpdesk').translation;
  const available = useDeskTranslationAvailable();
  const [on] = useTranslateOn(conversation.id);
  const ids = customerMessageIds(conversation.messages ?? []);
  const target = agentLocale();
  const query = useDeskConversationTranslations(conversation.id, target, ids, available && on);
  const language = query.data?.language ?? conversationLanguage(conversation);

  useEffect(() => {
    if (query.error) toast.error(translationErrorMessage(query.error));
  }, [query.error]);

  if (!available || !language) return null;
  const same = sameLanguage(language, target);

  return (
    <span
      className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground flex-shrink-0"
      title={same ? t.sameLanguage : t.languageBadge.replace('{language}', languageLabel(language))}
      data-testid="desk-inbox-language-badge"
    >
      {language}
    </span>
  );
}

/** "Translate this conversation" / "Stop translating" in the header's "⋯" menu. */
export function TranslateMenuItem({ conversationId }: Readonly<{ conversationId: string }>) {
  const t = getTranslations('helpdesk').translation;
  const available = useDeskTranslationAvailable();
  const [on, setOn] = useTranslateOn(conversationId);

  if (!available) return null;

  return (
    <DropdownMenuItem onSelect={() => setOn(!on)} data-testid="desk-inbox-translate-toggle">
      <Languages className="h-4 w-4" />
      {on ? t.turnOff : t.turnOn}
    </DropdownMenuItem>
  );
}
