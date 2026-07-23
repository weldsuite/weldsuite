import { useState } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Separator } from '@weldsuite/ui/components/separator';
import { usePerson } from '@/components/objects/person/use-person-data';
import { useDeskConversations, type DeskConversation } from '@/hooks/queries/use-desk-queries';

const CHANNEL_LABEL_KEYS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api'] as const;

interface DetailsPanelProps {
  conversation: DeskConversation;
  onSelectConversation: (id: string) => void;
}

function ContactBlock({ contactId }: { contactId: string | null }) {
  const t = getTranslations('deskInbox2');
  const { data, isLoading } = usePerson(contactId ?? '', !!contactId);

  if (!contactId) {
    return <p className="text-sm text-muted-foreground">{t.details.noContact}</p>;
  }
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">…</p>;
  }
  const person = data?.data;
  if (!person) {
    return <p className="text-sm text-muted-foreground">{t.details.noContact}</p>;
  }

  const name = person.displayName || person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ');
  const initial = (name || person.email || '?').slice(0, 1).toUpperCase();

  return (
    <div className="flex items-center gap-2.5">
      <Avatar className="h-9 w-9">
        {person.avatarUrl && <AvatarImage src={person.avatarUrl} />}
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{name || t.details.noContact}</p>
        {person.email && <p className="text-xs text-muted-foreground truncate">{person.email}</p>}
      </div>
    </div>
  );
}

function RecentConversationsBlock({
  contactId,
  currentId,
  onSelect,
}: {
  contactId: string | null;
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const t = getTranslations('deskInbox2');
  const { data, isLoading } = useDeskConversations(contactId ? { contactId } : {}, 'newest');

  if (!contactId) return null;

  const conversations = (data?.pages.flatMap((page) => page.data) ?? []).filter((c) => c.id !== currentId).slice(0, 5);

  if (!isLoading && conversations.length === 0) {
    return <p className="text-xs text-muted-foreground">{t.details.noRecentConversations}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className="text-left text-xs px-2 py-1.5 rounded-md hover:bg-accent transition-colors flex items-center justify-between gap-2"
        >
          <span className="truncate">
            #{c.conversationNumber} {c.title ?? c.source?.subject ?? ''}
          </span>
          <span className="text-muted-foreground shrink-0">{c.state}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Right details panel: contact, attributes, rating, recent conversations.
 * Collapsible to a thin rail (Intercom-style) via the chevron in the header.
 */
export function DetailsPanel({ conversation, onSelectConversation }: DetailsPanelProps) {
  const t = getTranslations('deskInbox2');
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="w-10 shrink-0 border-l flex flex-col items-center py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setCollapsed(false)}
          aria-label={t.details.expand}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  const channelLabel = CHANNEL_LABEL_KEYS.includes(conversation.channel as (typeof CHANNEL_LABEL_KEYS)[number])
    ? t.channel[conversation.channel]
    : conversation.channel;

  return (
    <div className="w-[300px] shrink-0 border-l flex flex-col h-full overflow-y-auto" data-testid="desk-inbox2-details-panel">
      <div className="flex items-center justify-between px-3 py-2.5 border-b">
        <span className="text-sm font-semibold">{t.details.title}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setCollapsed(true)}
          aria-label={t.details.collapse}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t.details.contact}</h3>
          <ContactBlock contactId={conversation.contactId} />
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t.details.attributes}</h3>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t.details.state}</dt>
              <dd>
                <Badge variant="outline" className="text-[11px]">
                  {conversation.state}
                </Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t.details.priority}</dt>
              <dd className={cn(conversation.priority && 'text-destructive font-medium')}>
                {conversation.priority ? t.details.priorityYes : t.details.priorityNo}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t.details.channel}</dt>
              <dd>{channelLabel}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t.details.waitingSince}</dt>
              <dd>{conversation.waitingSince ? format(new Date(conversation.waitingSince), 'PPp') : t.details.notWaiting}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t.details.createdAt}</dt>
              <dd>{format(new Date(conversation.createdAt), 'PPp')}</dd>
            </div>
          </dl>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t.details.rating}</h3>
          {conversation.conversationRating ? (
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={cn(
                    'h-4 w-4',
                    i < conversation.conversationRating!.rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
                  )}
                />
              ))}
              {conversation.conversationRating.remark && (
                <span className="text-xs text-muted-foreground ml-1 truncate">{conversation.conversationRating.remark}</span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t.details.noRating}</p>
          )}
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t.details.recentConversations}
          </h3>
          <RecentConversationsBlock
            contactId={conversation.contactId}
            currentId={conversation.id}
            onSelect={onSelectConversation}
          />
        </section>
      </div>
    </div>
  );
}
