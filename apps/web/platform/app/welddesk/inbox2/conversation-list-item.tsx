import { formatDistanceToNow } from 'date-fns';
import { Flag, Mail, MessageCircle, Phone, MessageSquare, Globe } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import type { DeskChannel, DeskConversation } from '@/hooks/queries/use-desk-queries';

const CHANNEL_ICONS: Record<DeskChannel, React.ComponentType<{ className?: string }>> = {
  messenger: MessageCircle,
  email: Mail,
  phone: Phone,
  whatsapp: MessageSquare,
  sms: MessageSquare,
  api: Globe,
};

function previewText(conversation: DeskConversation, noSubjectLabel: string): string {
  if (conversation.title) return conversation.title;
  if (conversation.source?.subject) return conversation.source.subject;
  if (conversation.source?.body) {
    const stripped = conversation.source.body.replace(/<[^>]*>/g, ' ').trim();
    return stripped.slice(0, 140) || noSubjectLabel;
  }
  return noSubjectLabel;
}

interface ConversationListItemProps {
  conversation: DeskConversation;
  active: boolean;
  onClick: () => void;
  /** Bulk-selection mode (Phase 2 "light table mode" — see conversation-list.tsx). */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelected?: (checked: boolean) => void;
}

export function ConversationListItem({
  conversation,
  active,
  onClick,
  selectionMode = false,
  selected = false,
  onToggleSelected,
}: ConversationListItemProps) {
  const t = getTranslations('deskInbox2');
  const ChannelIcon = CHANNEL_ICONS[conversation.channel] ?? Globe;
  const preview = previewText(conversation, t.list.noSubject);
  const timeLabel = conversation.waitingSince
    ? formatDistanceToNow(new Date(conversation.waitingSince), { addSuffix: true })
    : formatDistanceToNow(new Date(conversation.updatedAt), { addSuffix: true });

  return (
    <div
      className={cn(
        'group/item w-full text-left px-3 py-2.5 border-b flex flex-col gap-1 transition-colors cursor-pointer',
        active ? 'bg-accent' : 'hover:bg-accent/50',
        !conversation.read && 'bg-primary/5',
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      data-testid="desk-inbox2-conversation-item"
    >
      <div className="flex items-center gap-1.5">
        {(selectionMode || selected) && (
          <span
            className={cn(
              'shrink-0 flex items-center',
              !selected && 'opacity-0 group-hover/item:opacity-100 transition-opacity',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onToggleSelected?.(checked === true)}
              aria-label={t.list.selectConversation}
            />
          </span>
        )}
        {!conversation.read && <span className="h-2 w-2 rounded-full bg-primary shrink-0" aria-hidden />}
        <ChannelIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={cn('text-sm truncate flex-1', !conversation.read && 'font-semibold')}>
          #{conversation.conversationNumber} {preview}
        </span>
        {conversation.priority && <Flag className="h-3.5 w-3.5 text-destructive shrink-0" aria-label={t.list.priority} />}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
        <span className="truncate flex-1">{preview}</span>
        <span className="shrink-0">{timeLabel}</span>
      </div>
      {conversation.state === 'snoozed' && conversation.snoozedUntil && (
        <div className="pl-5">
          <Badge variant="outline" className="text-[11px] h-5">
            {t.list.snoozedUntil.replace('{date}', new Date(conversation.snoozedUntil).toLocaleString())}
          </Badge>
        </div>
      )}
      {!conversation.teamAssigneeId && !conversation.adminAssigneeId && (
        <div className="pl-5">
          <Badge variant="secondary" className="text-[11px] h-5">
            {t.list.unassignedBadge}
          </Badge>
        </div>
      )}
    </div>
  );
}
