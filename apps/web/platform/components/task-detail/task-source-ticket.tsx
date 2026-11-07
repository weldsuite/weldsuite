import { LifeBuoy } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { useTaskSourceTicket } from '@/hooks/queries/use-ticket-tasks-queries';

/**
 * "From ticket #N" on a task created from a WeldDesk conversation, linking to
 * it in the inbox. Nothing at all while it loads, or when the ticket can't be
 * read (no access, deleted): the link is simply not there.
 */
export function TaskSourceTicket({
  sourceType,
  sourceId,
}: Readonly<{ sourceType?: string | null; sourceId?: string | null }>) {
  const t = getTranslations('projects').fromTicket;
  const { data: ticket } = useTaskSourceTicket(sourceType, sourceId);
  if (!ticket) return null;
  const label = t.value.replace('{number}', String(ticket.conversationNumber));

  return (
    <div className="flex items-center gap-3" data-testid="task-source-ticket">
      <div className="flex items-center gap-2 w-32 flex-shrink-0">
        <LifeBuoy className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t.label}</span>
      </div>
      <div className="flex-1 min-w-0 h-8 text-sm rounded-md px-2 -mx-2 flex items-center">
        <Link
          href={ticket.channel === 'phone' ? `/welddesk/inbox/phone/${ticket.id}` : `/welddesk/inbox/${ticket.id}`}
          className="truncate font-medium text-foreground hover:text-primary transition-colors"
          title={ticket.title ?? undefined}
        >
          {label}
        </Link>
      </div>
    </div>
  );
}
