import { useState } from 'react';
import { toast } from 'sonner';
import { Link2, Plus, Siren, Unlink } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import {
  deskLinkErrorMessage,
  useDeskConversationLinks,
  useSetDeskConversationParent,
  type DeskLinkSummary,
} from '@/hooks/queries/use-desk-link-queries';
import { TicketPickerDialog, customerLabel, ticketLabel } from './ticket-picker-dialog';

/** The inbox thread of a linked conversation. */
export function ticketHref(ticket: Pick<DeskLinkSummary, 'id' | 'channel'>): string {
  return ticket.channel === 'phone' ? `/welddesk/inbox/phone/${ticket.id}` : `/welddesk/inbox/${ticket.id}`;
}

function LinkRow({
  ticket,
  onUnlink,
  unlinkLabel,
  disabled,
}: Readonly<{ ticket: DeskLinkSummary; onUnlink?: () => void; unlinkLabel: string; disabled?: boolean }>) {
  const t = getTranslations('helpdesk').ticketLinks;
  return (
    <div className="group flex items-center gap-2 py-1 text-sm" data-testid="desk-linked-ticket">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', ticket.state === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
        title={ticket.state === 'open' ? t.stateOpen : t.stateClosed}
      />
      <Link href={ticketHref(ticket)} className="min-w-0 flex-1" title={t.openTicket.replace('{number}', String(ticket.conversationNumber))}>
        <span className="block truncate hover:text-primary">{ticketLabel(ticket)}</span>
        <span className="block truncate text-xs text-muted-foreground">{customerLabel(ticket)}</span>
      </Link>
      {onUnlink && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onUnlink}
          disabled={disabled}
          aria-label={unlinkLabel}
          title={unlinkLabel}
        >
          <Unlink className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * Linked tickets in the details panel: the parent, the children (the
 * affected customers of a major incident), the duplicates merged in, and the
 * one this was merged into. Linking goes one level deep, so the buttons only
 * offer what the server allows.
 */
export function LinkedTicketsSection({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('helpdesk').ticketLinks;
  const canUpdate = useCan('conversations:update');
  const { data: links } = useDeskConversationLinks(conversation.id);
  const setParent = useSetDeskConversationParent();
  const [picking, setPicking] = useState<'parent' | 'child' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!links) return null;
  const incident = conversation.isMajorIncident === true;
  const merged = links.mergedInto;
  const isChild = links.parent !== null;
  const hasChildren = links.children.length > 0;
  const empty = !links.parent && !hasChildren && !merged && links.mergedFrom.length === 0;
  const canLinkParent = canUpdate && !merged && !incident && !hasChildren && !isChild;
  const canAddChild = canUpdate && !merged && !isChild;

  const link = (id: string, parentId: string | null, onDone?: () => void) =>
    setParent.mutate(
      { id, parentId },
      {
        onSuccess: () => {
          setRefusal(null);
          onDone?.();
        },
        onError: (err) => {
          const message = deskLinkErrorMessage(err) ?? t.saveError;
          if (onDone) setRefusal(message);
          else toast.error(message);
        },
      },
    );

  const onPick = (picked: DeskConversation) => {
    const close = () => setPicking(null);
    if (picking === 'parent') link(conversation.id, picked.id, close);
    else link(picked.id, conversation.id, close);
  };

  const exclude = [conversation.id, ...links.children.map((child) => child.id), ...(links.parent ? [links.parent.id] : [])];

  return (
    <div className="px-4 py-3 border-b border-border/60" data-testid="desk-inbox-linked-tickets">
      <div className="flex items-center justify-between mb-1 gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.title}</p>
        {incident && (
          <SoftBadge tone="danger" className="gap-1">
            <Siren className="h-3 w-3" />
            {t.majorIncident}
          </SoftBadge>
        )}
      </div>

      {merged && (
        <InfoBanner variant="info" className="my-2">
          <Link href={ticketHref(merged)} className="underline underline-offset-2">
            {t.mergedBanner.replace('{number}', String(merged.conversationNumber))}
          </Link>
        </InfoBanner>
      )}

      {links.parent && (
        <div className="mb-1">
          <p className="text-xs text-muted-foreground">{t.parent}</p>
          <LinkRow
            ticket={links.parent}
            unlinkLabel={t.unlink}
            disabled={setParent.isPending}
            onUnlink={canUpdate ? () => link(conversation.id, null) : undefined}
          />
        </div>
      )}

      {hasChildren && (
        <div className="mb-1">
          <p className="text-xs text-muted-foreground">{incident ? t.affectedCustomers : t.children}</p>
          {links.children.map((child) => (
            <LinkRow
              key={child.id}
              ticket={child}
              unlinkLabel={t.unlink}
              disabled={setParent.isPending}
              onUnlink={canUpdate ? () => link(child.id, null) : undefined}
            />
          ))}
        </div>
      )}

      {links.mergedFrom.length > 0 && (
        <div className="mb-1">
          <p className="text-xs text-muted-foreground">{t.mergedFrom}</p>
          {links.mergedFrom.map((duplicate) => (
            <LinkRow key={duplicate.id} ticket={duplicate} unlinkLabel={t.unlink} />
          ))}
        </div>
      )}

      {empty && <p className="text-sm text-muted-foreground py-1">{t.none}</p>}

      {(canLinkParent || canAddChild) && (
        <div className="flex flex-wrap gap-1 pt-1">
          {canAddChild && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicking('child')} data-testid="desk-link-child">
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t.addChild}
            </Button>
          )}
          {canLinkParent && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicking('parent')} data-testid="desk-link-parent">
              <Link2 className="h-3.5 w-3.5 mr-1" />
              {t.linkParent}
            </Button>
          )}
        </div>
      )}

      <TicketPickerDialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPicking(null);
            setRefusal(null);
          }
        }}
        title={picking === 'parent' ? t.pickParentTitle : t.pickChildTitle}
        exclude={exclude}
        disabled={setParent.isPending}
        notice={refusal ? <InfoBanner variant="warning">{refusal}</InfoBanner> : undefined}
        onPick={onPick}
      />
    </div>
  );
}
