import { formatDistanceToNow } from 'date-fns';
import { MessageCircle } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';

function previewText(conversation: DeskConversation, fallback: string): string {
  if (conversation.lastMessagePreview) return conversation.lastMessagePreview;
  if (conversation.title) return conversation.title;
  if (conversation.name) return conversation.name;
  if (conversation.email) return conversation.email;
  return fallback;
}

interface ConversationListItemProps {
  conversation: DeskConversation;
  active: boolean;
  onClick: () => void;
}

export function ConversationListItem({ conversation, active, onClick }: ConversationListItemProps) {
  const t = getTranslations('deskInbox2');
  const preview = previewText(conversation, t.list.noSubject);
  const timeSource = conversation.lastMessageAt ?? conversation.waitingSince ?? conversation.updatedAt;
  const timeLabel = formatDistanceToNow(new Date(timeSource), { addSuffix: true });
  const waiting = Boolean(conversation.waitingSince);

  return (
    <div
      className={cn(
        'w-full text-left px-3 py-2.5 border-b flex flex-col gap-1 transition-colors cursor-pointer',
        active ? 'bg-accent' : 'hover:bg-accent/50',
        waiting && 'bg-primary/5',
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      data-testid="desk-inbox-conversation-item"
    >
      <div className="flex items-center gap-1.5">
        {waiting && <span className="h-2 w-2 rounded-full bg-primary shrink-0" aria-hidden />}
        <MessageCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={cn('text-sm truncate flex-1', waiting && 'font-semibold')}>
          #{conversation.conversationNumber} {conversation.name || conversation.email || preview}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
        <span className="truncate flex-1">{preview}</span>
        <span className="shrink-0">{timeLabel}</span>
      </div>
      {!conversation.assigneeId && (
        <div className="pl-5">
          <Badge variant="secondary" className="text-[11px] h-5">
            {t.list.unassignedBadge}
          </Badge>
        </div>
      )}
    </div>
  );
}
