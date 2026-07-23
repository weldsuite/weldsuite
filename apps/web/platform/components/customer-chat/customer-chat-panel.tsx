import { EntityChat } from '@/components/entity-chat/entity-chat';

interface CustomerChatPanelProps {
  customerId: string;
  customerName?: string;
  ownerId?: string | null;
  accountManagerId?: string | null;
  /** Backend entity type for the chat channel. Defaults to 'customer'.
   *  Pass any entity type (e.g. 'contact', 'domain') that the server-side
   *  entity-channel registry knows about. */
  entityType?: string;
  /** Retained for API compatibility — header is no longer rendered. */
  compactHeader?: boolean;
}

export function CustomerChatPanel({
  customerId,
  customerName,
  entityType = 'customer',
}: CustomerChatPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <EntityChat
          entityType={entityType}
          entityId={customerId}
          fallbackName={customerName}
          hideHeader
        />
      </div>
    </div>
  );
}
