import { toast } from 'sonner';
import { Loader2, Settings2, Ticket } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { HeaderIconButton } from '@weldsuite/ui/components/header-icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { stripWorkspacePrefix } from '@/lib/workspace-url';
import {
  useDeskAttributeOptions,
  useUpdateDeskConversationAttributes,
  type DeskConversation,
} from '@/hooks/queries/use-desk-queries';

/**
 * A conversation is a ticket once it has a ticket type: that is what the
 * customer panel's Ticket tab and this button go by.
 */
export function isDeskTicket(conversation: Pick<DeskConversation, 'ticketTypeId'>): boolean {
  return Boolean(conversation.ticketTypeId);
}

/**
 * "Create ticket" in the conversation header, for a conversation that isn't a
 * ticket yet: picking a ticket type makes it one, and the customer panel then
 * opens on its Ticket tab.
 */
export function CreateTicketAction({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('deskInbox2');
  const router = useRouter();
  const canUpdate = useCan('conversations:update');
  const { data: options } = useDeskAttributeOptions();
  const update = useUpdateDeskConversationAttributes();

  if (!canUpdate || isDeskTicket(conversation) || conversation.mergedIntoId) return null;

  const types = options?.ticketTypes ?? [];
  const create = (ticketTypeId: string) =>
    update.mutate(
      { id: conversation.id, data: { ticketTypeId } },
      {
        onSuccess: () => toast.success(t.header.ticketCreated),
        onError: () => toast.error(t.ticket.saveError),
      },
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderIconButton label={t.header.createTicket} disabled={update.isPending} data-testid="desk-inbox-create-ticket">
          {update.isPending ? <Loader2 className="animate-spin" /> : <Ticket />}
        </HeaderIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t.header.ticketTypeLabel}</DropdownMenuLabel>
        {types.length === 0 && <DropdownMenuItem disabled>{t.header.noTicketTypes}</DropdownMenuItem>}
        {types.map((type) => (
          <DropdownMenuItem key={type.id} onSelect={() => create(type.id)} data-testid="desk-inbox-create-ticket-type">
            <span className="truncate">{type.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            try {
              // The Settings back button returns to this conversation.
              sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname));
            } catch {
              // Storage can be blocked; the link still works.
            }
            router.push('/settings/apps/welddesk/ticket-types');
          }}
        >
          <Settings2 className="h-4 w-4" />
          {t.ticket.manageTypes}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
