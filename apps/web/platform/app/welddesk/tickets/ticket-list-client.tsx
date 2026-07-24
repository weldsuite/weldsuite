import React, { useState, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Toggle } from '@weldsuite/ui/components/toggle';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import { Loader2, Plus } from 'lucide-react';
import {
  useTickets,
  useTicketTypes,
  type ApiTicket,
  type TicketTypeConfig,
} from '@/hooks/queries/use-helpdesk-queries';
import { CreateTicketDialog } from './create-ticket-dialog';

// ============================================================================
// Helpers
// ============================================================================

type StatusFilter = 'all' | 'open' | 'pending' | 'resolved' | 'closed';

function ticketToItem(
  ticket: ApiTicket,
  typeNameMap: Record<string, string>,
  typeCategoryMap: Record<string, string>,
  labels_: { internal: string; tracker: string; unknown: string; noSubject: string },
): ConversationItem {
  const labels: string[] = [];
  if (ticket.ticketTypeId && typeNameMap[ticket.ticketTypeId]) {
    labels.push(typeNameMap[ticket.ticketTypeId]);
  }

  const category = ticket.ticketTypeId ? typeCategoryMap[ticket.ticketTypeId] : undefined;
  if (category === 'back-office') {
    labels.push(labels_.internal);
  } else if (category === 'tracker') {
    labels.push(labels_.tracker);
  }

  return {
    id: ticket.id,
    name: ticket.customerName || ticket.customerEmail || labels_.unknown,
    email: ticket.customerEmail,
    subject: ticket.subject || labels_.noSubject,
    preview: ticket.description || '',
    date: new Date(ticket.createdAt),
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    labels,
    messageCount: 1,
    unreadCount: 0,
  };
}

// ============================================================================
// Component
// ============================================================================

export default function TicketListClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  const tp = t.helpdesk.ticketsPage;

  useBreadcrumbs([
    { label: tp.helpdeskBreadcrumb, href: '/welddesk' },
    { label: tp.ticketsBreadcrumb },
  ]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const filters = useMemo(() => ({
    status: statusFilter !== 'all' ? statusFilter : undefined,
    priority: priorityFilter !== 'all' ? priorityFilter : undefined,
    ticketTypeId: typeFilter !== 'all' ? typeFilter : undefined,
    page,
    pageSize: 25,
  }), [statusFilter, priorityFilter, typeFilter, page]);

  const { data: ticketsData, isLoading } = useTickets(filters);
  const { data: ticketTypes } = useTicketTypes();

  const tickets = useMemo(() => ticketsData?.data || [], [ticketsData]);

  const selectedTicketId = pathname.split('/').pop();

  const typeNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    (ticketTypes || []).forEach((t: TicketTypeConfig) => { map[t.id] = t.name; });
    return map;
  }, [ticketTypes]);

  const typeCategoryMap = useMemo(() => {
    const map: Record<string, string> = {};
    (ticketTypes || []).forEach((t: TicketTypeConfig) => { map[t.id] = t.category || 'customer'; });
    return map;
  }, [ticketTypes]);

  const labelStrings = useMemo(() => ({
    internal: tp.labelInternal,
    tracker: tp.labelTracker,
    unknown: tp.unknownCustomer,
    noSubject: tp.noSubject,
  }), [tp]);

  const items = useMemo(
    () => tickets.map((t) => ticketToItem(t, typeNameMap, typeCategoryMap, labelStrings)),
    [tickets, typeNameMap, typeCategoryMap, labelStrings],
  );

  const handleItemClick = (item: ConversationItem) => {
    router.push(`/welddesk/tickets/${item.id}`);
  };

  const activeTypes = (ticketTypes || []).filter((t: TicketTypeConfig) => t.isActive);
  const activeFilterCount = (statusFilter !== 'all' ? 1 : 0) + (priorityFilter !== 'all' ? 1 : 0) + (typeFilter !== 'all' ? 1 : 0);

  const filterContent = (
    <div className="flex items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-8 text-sm px-3 shadow-none gap-1.5',
              activeFilterCount > 0 ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {tp.filterButton}
            {activeFilterCount > 0 && (
              <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-3 space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{tp.filterStatusLabel}</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { value: 'all' as StatusFilter, label: tp.filterAll },
                { value: 'open' as StatusFilter, label: tp.filterOpen },
                { value: 'pending' as StatusFilter, label: tp.filterPending },
                { value: 'resolved' as StatusFilter, label: tp.filterResolved },
                { value: 'closed' as StatusFilter, label: tp.filterClosed },
              ].map(({ value, label }) => (
                <Toggle
                  key={value}
                  size="sm"
                  variant="outline"
                  pressed={statusFilter === value}
                  onPressedChange={() => { setStatusFilter(value); setPage(1); }}
                  className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
                >
                  {label}
                </Toggle>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{tp.filterPriorityLabel}</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { value: 'all', label: tp.filterAll },
                { value: 'urgent', label: tp.filterUrgent },
                { value: 'high', label: tp.filterHigh },
                { value: 'normal', label: tp.filterNormal },
                { value: 'low', label: tp.filterLow },
              ].map(({ value, label }) => (
                <Toggle
                  key={value}
                  size="sm"
                  variant="outline"
                  pressed={priorityFilter === value}
                  onPressedChange={() => { setPriorityFilter(value); setPage(1); }}
                  className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
                >
                  {label}
                </Toggle>
              ))}
            </div>
          </div>
          {activeTypes.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">{tp.filterTypeLabel}</p>
              <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={tp.filterAllTypes} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tp.filterAllTypes}</SelectItem>
                  {activeTypes.map((t: TicketTypeConfig) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-2.5 shadow-none"
        onClick={() => setShowCreateDialog(true)}
        data-testid="tickets-create-btn"
        aria-label={st('sweep.welddesk.tickets.createTicketAriaLabel')}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t.helpdesk.inbox.loading}</span>
      </div>
    );
  }

  return (
    <>
      <ConversationList
        items={items}
        selectedId={selectedTicketId}
        getItemUrl={(item) => `/welddesk/tickets/${item.id}`}
        onItemClick={handleItemClick}
        filterContent={filterContent}
        emptyMessage={t.helpdesk.ticketsPage.noTicketsFound}
      />
      <CreateTicketDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </>
  );
}
