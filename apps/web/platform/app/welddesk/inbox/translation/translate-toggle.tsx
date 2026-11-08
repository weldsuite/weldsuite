import { useEffect } from 'react';
import { toast } from 'sonner';
import { Languages, Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
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
 * The conversation header's "Translate" switch and the customer's language.
 * Turning it on translates the customer's messages into the agent's
 * language (under each message in the timeline); hidden where the edition
 * has no AI or the agent can't work the conversation.
 */
export function TranslateToggle({
  conversation,
}: Readonly<{ conversation: DeskConversation & { messages?: DeskMessage[] } }>) {
  const t = getTranslations('helpdesk').translation;
  const available = useDeskTranslationAvailable();
  const [on, setOn] = useTranslateOn(conversation.id);
  const ids = customerMessageIds(conversation.messages ?? []);
  const target = agentLocale();
  const query = useDeskConversationTranslations(conversation.id, target, ids, available && on);
  const language = query.data?.language ?? conversationLanguage(conversation);

  useEffect(() => {
    if (query.error) toast.error(translationErrorMessage(query.error));
  }, [query.error]);

  if (!available) return null;
  const same = sameLanguage(language, target);

  return (
    <div className="hidden md:flex items-center gap-1 flex-shrink-0" data-testid="desk-inbox-translate">
      {language && (
        <span
          className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground"
          title={same ? t.sameLanguage : t.languageBadge.replace('{language}', languageLabel(language))}
          data-testid="desk-inbox-language-badge"
        >
          {language}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={on}
        title={on ? t.turnOff : t.turnOn}
        className={cn(
          'h-8 px-2 gap-1.5 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary',
          on && 'bg-muted text-foreground',
        )}
        onClick={() => setOn(!on)}
        data-testid="desk-inbox-translate-toggle"
      >
        {on && query.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
        <span className="hidden lg:inline">{t.translate}</span>
      </Button>
    </div>
  );
}
