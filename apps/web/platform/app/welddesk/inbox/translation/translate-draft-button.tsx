import { useEffect } from 'react';
import { toast } from 'sonner';
import { Languages, Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { useDeskConversation } from '@/hooks/queries/use-desk-queries';
import { conversationLanguage, useTranslateDeskReply } from '@/hooks/queries/use-desk-translation-queries';
import {
  agentLocale,
  languageLabel,
  sameLanguage,
  translationErrorMessage,
  useDeskTranslationAvailable,
  useDraftTranslation,
} from './translation-state';

interface TranslateDraftButtonProps {
  conversationId: string;
  /** The composer's text. */
  body: string;
  /** Notes stay in the agent's language. */
  disabled?: boolean;
  /** Puts the translation in the composer for the agent to check and edit. */
  onTranslated: (text: string) => void;
}

/**
 * The composer's "Translate to <language>": the draft goes into the
 * customer's language and replaces the text, for the agent to check. What
 * they wrote is kept for the send (`translation` metadata on the reply).
 */
export function TranslateDraftButton({ conversationId, body, disabled, onTranslated }: Readonly<TranslateDraftButtonProps>) {
  const t = getTranslations('helpdesk').translation;
  const available = useDeskTranslationAvailable();
  const { data } = useDeskConversation(conversationId);
  const language = conversationLanguage(data?.data);
  const translate = useTranslateDeskReply();
  const [draft, setDraft] = useDraftTranslation(conversationId);

  // An emptied composer is a new draft: what was translated no longer applies.
  useEffect(() => {
    if (draft && !body.trim()) setDraft(undefined);
  }, [body, draft, setDraft]);

  if (!available || disabled) return null;
  if (language && sameLanguage(language, agentLocale())) return null;

  const label = language ? t.translateDraft.replace('{language}', languageLabel(language)) : t.languageUnknown;
  const text = body.trim();
  const alreadyTranslated = !!draft && draft.translated === text;

  const run = async () => {
    if (!language || !text || alreadyTranslated) return;
    try {
      const result = await translate.mutateAsync({ conversationId, text, targetLocale: language });
      setDraft({
        original: text,
        sourceLocale: result.sourceLocale ?? agentLocale(),
        targetLocale: result.targetLocale,
        translated: result.text.trim(),
      });
      onTranslated(result.text);
      toast.success(t.draftTranslated);
    } catch (err) {
      toast.error(translationErrorMessage(err));
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground"
      onClick={() => void run()}
      disabled={!language || !text || alreadyTranslated || translate.isPending}
      title={label}
      aria-label={label}
      data-testid="desk-inbox-composer-translate"
    >
      {translate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
    </Button>
  );
}
