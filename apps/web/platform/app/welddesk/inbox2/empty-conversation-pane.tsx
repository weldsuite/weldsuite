import { MessageSquareText } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

/** Placeholder shown in the conversation-pane slot when no conversation is selected. */
export function EmptyConversationPane() {
  const t = getTranslations('deskInbox2');
  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-2 text-center px-6">
      <MessageSquareText className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">{t.pane.selectTitle}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{t.pane.selectDescription}</p>
    </div>
  );
}
