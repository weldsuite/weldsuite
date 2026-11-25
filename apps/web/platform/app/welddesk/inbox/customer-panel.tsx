import { useEffect, useMemo, useRef } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import {
  CalendarClock,
  CircleDot,
  Clock,
  Fingerprint,
  Hash,
  Info,
  Loader2,
  Mail,
  MessagesSquare,
  Star,
  Ticket,
  UserRound,
} from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { ObjectPanelTabs } from '@/components/object-panel';
import { PersonPanel, type PersonPanelExtraTab } from '@/components/objects/person/person-panel';
import { useEnsurePersonForEmail, usePeopleByEmails } from '@/components/objects/person/use-person-data';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import {
  useDeskCustomerConversations,
  type DeskChannel,
  type DeskConversation,
} from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';
import { TicketFields } from './ticket-fields';
import { ConversationAssets } from './assets/conversation-assets';
import { TicketTasksSection } from './ticket-tasks-section';
import { LinkedTicketsSection } from './linked-tickets-section';
import { ServiceRequestSection } from './service-request-section';
import { ProblemSection } from './problem-section';
import { isDeskTicket } from './create-ticket-action';

/** The person panel's width, for the panel shown while there is no person. */
const PANEL_WIDTH = 400;
const TICKET_TAB = 'ticket';
const DETAILS_TAB = 'details';

interface CustomerPanelProps {
  conversation: DeskConversation;
  members: DeskWorkspaceMember[];
  onClose: () => void;
}

/** The visitor's CSAT answer as five stars, filled up to the rating. */
function RatingStars({ rating }: Readonly<{ rating: number }>) {
  return (
    <span className="inline-flex" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn('h-3.5 w-3.5', star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')}
        />
      ))}
    </span>
  );
}

/** The customer's other conversations, newest first as the API returns them. */
function OtherConversationsSection({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('deskInbox2');
  const { data: related, isLoading } = useDeskCustomerConversations(conversation);
  const others = (related ?? []).filter((c) => c.id !== conversation.id);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{t.customer.otherConversations}</h3>
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
    </section>
  );
}

/** The open conversation: who, where, its state, assignee and the visitor's rating. */
function ConversationRows({ conversation, members }: Readonly<Omit<CustomerPanelProps, 'onClose'>>) {
  const t = getTranslations('deskInbox2');
  const assignee = members.find((m) => m.userId === conversation.assigneeId);
  const channelLabel: Record<DeskChannel, string> = {
    messenger: t.channel.messenger,
    email: t.channel.email,
    phone: t.channel.phone,
    whatsapp: 'WhatsApp',
    sms: 'SMS',
    api: 'API',
    portal: t.channel.portal,
  };

  return (
    <div className="space-y-1">
      <PanelRow icon={Mail} label={t.customer.email} value={conversation.email} type="email" />
      <PanelRow icon={Hash} label={t.customer.conversation} value={`#${conversation.conversationNumber}`} />
      <PanelRow icon={MessagesSquare} label={t.customer.channel} value={channelLabel[conversation.channel]} />
      {conversation.externalId && (
        <PanelRow
          icon={Fingerprint}
          label={t.customer.externalId}
          value={conversation.externalId}
          renderValue={(value) => <span className="font-mono text-xs break-all">{value}</span>}
        />
      )}
      <PanelRow
        icon={CircleDot}
        label={t.details.state}
        value={conversation.state === 'open' ? t.tabs.open : t.tabs.closed}
      />
      <PanelRow icon={UserRound} label={t.customer.assignee} value={assignee?.name ?? t.sidebar.unassigned} />
      <PanelRow
        icon={CalendarClock}
        label={t.customer.started}
        value={format(new Date(conversation.createdAt), 'PP p')}
        tabular
      />
      {conversation.waitingSince && conversation.state === 'open' && (
        <PanelRow
          icon={Clock}
          label={t.customer.waiting}
          value={formatDistanceToNowStrict(new Date(conversation.waitingSince))}
        />
      )}
      {conversation.rating != null && (
        <div data-testid="desk-inbox-customer-rating">
          <PanelRow
            icon={Star}
            label={t.customer.rating}
            value={t.timeline.ratingLabel.replace('{rating}', String(conversation.rating))}
            renderValue={(value) => (
              <span className="inline-flex items-center gap-1.5">
                <RatingStars rating={conversation.rating ?? 0} />
                {value}
              </span>
            )}
          />
          {conversation.ratingComment && (
            <p className="pl-[128px] pb-1.5 text-sm italic text-muted-foreground whitespace-pre-wrap break-words">
              “{conversation.ratingComment}”
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Ticket tab, for a conversation that is a ticket: the conversation, its
 * ticket fields and everything linked to it.
 */
function TicketTab({ conversation, members }: Readonly<Omit<CustomerPanelProps, 'onClose'>>) {
  return (
    <div className="p-4 space-y-6" data-testid="desk-inbox-ticket-tab">
      <ConversationRows conversation={conversation} members={members} />
      <TicketFields conversation={conversation} />
      <ConversationAssets conversation={conversation} />
      <LinkedTicketsSection conversation={conversation} />
      <ServiceRequestSection conversation={conversation} members={members} />
      <ProblemSection conversation={conversation} />
      <TicketTasksSection conversationId={conversation.id} />
      <OtherConversationsSection conversation={conversation} />
    </div>
  );
}

/**
 * The CRM person the conversation is with: the linked contact, else the person
 * with the visitor's email, else one created from that email (as WeldMail's
 * customer panel does) when the agent may create people. A visitor without an
 * email has none.
 */
function useConversationPerson(conversation: DeskConversation): { personId: string | null; resolving: boolean } {
  const { can } = usePermissions();
  const canCreate = can('people:create');
  const email = conversation.contactId ? null : conversation.email?.trim() || null;
  const lookup = usePeopleByEmails(email ? [email] : [], Boolean(email));
  const found = lookup.data?.data?.[0]?.id ?? null;
  const ensure = useEnsurePersonForEmail();
  const { mutate: ensurePerson } = ensure;
  // One create per email per mount; a created person lands in the lookup's cache, so a remount finds it.
  const attemptedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!email || !canCreate || !lookup.isSuccess || lookup.isFetching || found || attemptedFor.current === email) {
      return;
    }
    attemptedFor.current = email;
    const parts = (conversation.name ?? '').trim().split(/\s+/).filter(Boolean);
    ensurePerson({
      firstName: parts[0] ?? email.split('@')[0] ?? email,
      lastName: parts.slice(1).join(' ') || undefined,
      email,
    });
  }, [email, canCreate, lookup.isSuccess, lookup.isFetching, found, conversation.name, ensurePerson]);

  // A 409 means the person exists; the lookup is read again, so keep waiting for it.
  const conflict = ensure.isError && isApiError(ensure.error) && ensure.error.status === 409;
  const createFailed = ensure.isError && !conflict;
  const personId = conversation.contactId ?? found;
  const resolving = !personId && Boolean(email) && !lookup.isError && (canCreate ? !createFailed : lookup.isLoading);
  return { personId, resolving };
}

/**
 * While there is no person: the same shell, with the Ticket tab for a ticket
 * and otherwise only the conversation's details.
 */
function VisitorPanel({
  conversation,
  members,
  onClose,
  loading,
}: Readonly<CustomerPanelProps & { loading: boolean }>) {
  const t = getTranslations('deskInbox2');
  const displayName = conversation.name || conversation.email || t.pane.visitor;
  const isTicket = isDeskTicket(conversation);
  return (
    <EntityDetailView
      mode="panel"
      width={PANEL_WIDTH}
      showExpandButton={false}
      onClose={onClose}
      loading={loading}
      contentClassName={tabBodyClassName('panel')}
      avatar={
        <Avatar className="size-[22px]">
          <AvatarFallback className="bg-muted text-[10px] font-medium">
            {(displayName.trim()[0] ?? '#').toUpperCase()}
          </AvatarFallback>
        </Avatar>
      }
      title={<span className="block text-[15px] font-medium leading-6 text-foreground truncate">{displayName}</span>}
      tabs={
        <ObjectPanelTabs
          tabs={[
            isTicket
              ? { id: TICKET_TAB, label: t.ticket.title, icon: Ticket }
              : { id: DETAILS_TAB, label: t.customer.details, icon: Info },
          ]}
          activeTab={isTicket ? TICKET_TAB : DETAILS_TAB}
          onChange={() => undefined}
        />
      }
    >
      {isTicket ? (
        <TicketTab conversation={conversation} members={members} />
      ) : (
        <div className="p-4">
          <ConversationRows conversation={conversation} members={members} />
        </div>
      )}
    </EntityDetailView>
  );
}

/**
 * The inbox's right-hand panel: the customer's CRM person panel, the same
 * component WeldCRM opens. When the conversation is a ticket it gets a Ticket
 * tab in front, opened first; a plain support conversation shows the person's
 * record as it is ("Create ticket" in the header makes it a ticket).
 * Desktop-wide screens only; the thread keeps the full width below that.
 */
export function CustomerPanel({ conversation, members, onClose }: Readonly<CustomerPanelProps>) {
  const t = getTranslations('deskInbox2');
  const { personId, resolving } = useConversationPerson(conversation);
  const isTicket = isDeskTicket(conversation);

  const extraTabs = useMemo<PersonPanelExtraTab[] | undefined>(
    () =>
      isTicket
        ? [
            {
              id: TICKET_TAB,
              label: t.ticket.title,
              icon: Ticket,
              content: <TicketTab conversation={conversation} members={members} />,
            },
          ]
        : undefined,
    [isTicket, t.ticket.title, conversation, members],
  );

  return (
    <div className="hidden xl:flex flex-shrink-0" data-testid="desk-inbox-customer-panel">
      {personId ? (
        // Keyed on the ticket state too: a conversation that just became a ticket opens on its Ticket tab.
        <PersonPanel
          key={`${personId}:${isTicket ? 'ticket' : 'conversation'}`}
          id={personId}
          isOpen
          onClose={onClose}
          extraTabs={extraTabs}
        />
      ) : (
        <VisitorPanel conversation={conversation} members={members} onClose={onClose} loading={resolving} />
      )}
    </div>
  );
}
