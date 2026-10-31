import { format, formatDistanceToNowStrict } from 'date-fns';
import { Loader2, Star } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import {
  useDeskCustomerConversations,
  type DeskChannel,
  type DeskConversation,
} from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';
import { TicketFields } from './ticket-fields';

interface CustomerPanelProps {
  conversation: DeskConversation;
  members: DeskWorkspaceMember[];
}

function Row({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-right text-foreground min-w-0 break-words">{children}</span>
    </div>
  );
}

/** The visitor's CSAT answer as five stars, filled up to the rating. */
function RatingStars({ rating }: Readonly<{ rating: number }>) {
  return (
    <span className="inline-flex" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn(
            'h-3.5 w-3.5',
            star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40',
          )}
        />
      ))}
    </span>
  );
}

/**
 * Who the agent is talking to, and what else they've asked. Desktop-wide
 * screens only; the thread keeps the full width below that.
 */
export function CustomerPanel({ conversation, members }: Readonly<CustomerPanelProps>) {
  const t = getTranslations('deskInbox2');
  const { data: related, isLoading } = useDeskCustomerConversations(conversation);
  const others = (related ?? []).filter((c) => c.id !== conversation.id);
  const assignee = members.find((m) => m.userId === conversation.assigneeId);
  const channelLabel: Record<DeskChannel, string> = {
    messenger: t.channel.messenger,
    email: t.channel.email,
    phone: t.channel.phone,
    whatsapp: 'WhatsApp',
    sms: 'SMS',
    api: 'API',
  };
  const displayName = conversation.name || conversation.email || t.pane.visitor;

  return (
    <aside
      className="hidden xl:flex w-72 flex-shrink-0 flex-col border-l border-gray-200 dark:border-border overflow-y-auto"
      data-testid="desk-inbox-customer-panel"
    >
      <div className="px-4 pt-4 pb-3 border-b border-border/60">
        <p className="text-base font-semibold text-foreground truncate">{displayName}</p>
        {conversation.email && (
          <a
            href={`mailto:${conversation.email}`}
            className="block text-sm text-muted-foreground truncate hover:text-foreground"
          >
            {conversation.email}
          </a>
        )}
      </div>

      <div className="px-4 py-3 border-b border-border/60">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{t.customer.details}</p>
        <Row label={t.customer.conversation}>#{conversation.conversationNumber}</Row>
        <Row label={t.customer.channel}>{channelLabel[conversation.channel]}</Row>
        {conversation.externalId && (
          <Row label={t.customer.externalId}>
            <span className="font-mono text-xs break-all">{conversation.externalId}</span>
          </Row>
        )}
        <Row label={t.details.state}>
          {conversation.state === 'open' ? t.tabs.open : t.tabs.closed}
        </Row>
        <Row label={t.customer.assignee}>{assignee?.name ?? t.sidebar.unassigned}</Row>
        <Row label={t.customer.started}>{format(new Date(conversation.createdAt), 'PP p')}</Row>
        {conversation.waitingSince && conversation.state === 'open' && (
          <Row label={t.customer.waiting}>
            {formatDistanceToNowStrict(new Date(conversation.waitingSince))}
          </Row>
        )}
        {conversation.rating != null && (
          <div data-testid="desk-inbox-customer-rating">
            <Row label={t.customer.rating}>
              <span className="inline-flex items-center gap-1.5">
                <RatingStars rating={conversation.rating} />
                {t.timeline.ratingLabel.replace('{rating}', String(conversation.rating))}
              </span>
            </Row>
            {conversation.ratingComment && (
              <p className="pb-1.5 text-sm italic text-muted-foreground whitespace-pre-wrap break-words">
                “{conversation.ratingComment}”
              </p>
            )}
          </div>
        )}
      </div>

      <TicketFields conversation={conversation} />

      <div className="px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
          {t.customer.otherConversations}
        </p>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {!isLoading && others.length === 0 && (
          <p className="text-sm text-muted-foreground">{t.customer.noOtherConversations}</p>
        )}
        <ul className="space-y-1">
          {others.map((other) => (
            <li key={other.id}>
              <Link
                href={other.channel === 'phone' ? `/welddesk/inbox/phone/${other.id}` : `/welddesk/inbox/${other.id}`}
                className="block rounded-md px-2 py-1.5 -mx-2 hover:bg-muted transition-colors"
                data-testid="desk-inbox-customer-conversation"
              >
                <span className="flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full flex-shrink-0',
                      other.state === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="font-medium truncate">{other.title || `#${other.conversationNumber}`}</span>
                  <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
                    {format(new Date(other.lastMessageAt ?? other.createdAt), 'PP')}
                  </span>
                </span>
                {other.lastMessagePreview && (
                  <span className="block pl-3.5 text-xs text-muted-foreground truncate">{other.lastMessagePreview}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
