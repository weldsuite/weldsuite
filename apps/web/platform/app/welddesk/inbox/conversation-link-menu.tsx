import { useState } from 'react';
import { toast } from 'sonner';
import { GitMerge, Megaphone, Siren, XCircle } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import {
  deskLinkErrorMessage,
  deskLinkRefusal,
  useCloseDeskIncident,
  useDeskConversationLinks,
  useMergeDeskConversation,
  usePostDeskIncidentUpdate,
  useSetDeskMajorIncident,
} from '@/hooks/queries/use-desk-link-queries';
import { ConversationActionsMenu } from './conversation-actions-menu';
import { TicketPickerDialog } from './ticket-picker-dialog';

type Open = 'merge' | 'unmark' | 'update' | 'close' | null;

/**
 * The conversation header's "more actions" menu with the linked-ticket
 * actions: merge this duplicate, mark or unmark a major incident, post an
 * update to every linked customer, and close an incident with its tickets.
 */
export function ConversationLinkMenu({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('helpdesk').ticketLinks;
  const canUpdate = useCan('conversations:update');
  const { data: links } = useDeskConversationLinks(conversation.id);
  const merge = useMergeDeskConversation();
  const setIncident = useSetDeskMajorIncident();
  const postUpdate = usePostDeskIncidentUpdate();
  const closeIncident = useCloseDeskIncident();
  const [open, setOpen] = useState<Open>(null);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const [update, setUpdate] = useState('');
  const [closeChildren, setCloseChildren] = useState(true);

  const incident = conversation.isMajorIncident === true;
  const merged = Boolean(conversation.mergedIntoId);
  const isChild = Boolean(conversation.parentConversationId);
  const children = links?.children ?? [];
  const openChildren = children.filter((child) => child.state === 'open').length;
  const close = () => setOpen(null);

  const onMerge = (target: DeskConversation) =>
    merge.mutate(
      { id: conversation.id, targetId: target.id },
      {
        onSuccess: () => {
          toast.success(t.mergedInto.replace('{number}', String(target.conversationNumber)));
          setMergeNotice(null);
          close();
        },
        onError: (err) =>
          setMergeNotice(
            deskLinkRefusal(err) === 'different_customer' ? t.mergeDifferentCustomer : deskLinkErrorMessage(err) ?? t.saveError,
          ),
      },
    );

  const markIncident = (isMajorIncident: boolean) =>
    setIncident.mutate(
      { id: conversation.id, isMajorIncident },
      { onSuccess: close, onError: (err) => toast.error(deskLinkErrorMessage(err) ?? t.saveError) },
    );

  const sendUpdate = () =>
    postUpdate.mutate(
      { id: conversation.id, body: update.trim() },
      {
        onSuccess: (result) => {
          toast.success(t.updateSent.replace('{count}', String(result.data.delivered + 1)));
          setUpdate('');
          close();
        },
        onError: (err) => toast.error(deskLinkErrorMessage(err) ?? t.saveError),
      },
    );

  const items = canUpdate ? (
    <>
      <DropdownMenuSeparator />
      {!merged && !incident && (
        <DropdownMenuItem onSelect={() => setOpen('merge')} data-testid="desk-inbox-merge">
          <GitMerge className="h-4 w-4" />
          {t.merge}
        </DropdownMenuItem>
      )}
      {!incident && !merged && !isChild && (
        <DropdownMenuItem onSelect={() => markIncident(true)} data-testid="desk-inbox-mark-incident">
          <Siren className="h-4 w-4" />
          {t.markIncident}
        </DropdownMenuItem>
      )}
      {incident && (
        <>
          <DropdownMenuItem onSelect={() => setOpen('update')} data-testid="desk-inbox-incident-update">
            <Megaphone className="h-4 w-4" />
            {t.postUpdate}
          </DropdownMenuItem>
          {conversation.state === 'open' && (
            <DropdownMenuItem onSelect={() => setOpen('close')} data-testid="desk-inbox-close-incident">
              <XCircle className="h-4 w-4" />
              {t.closeIncident}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setOpen('unmark')} data-testid="desk-inbox-unmark-incident">
            <Siren className="h-4 w-4" />
            {t.unmarkIncident}
          </DropdownMenuItem>
        </>
      )}
    </>
  ) : null;

  return (
    <>
      <ConversationActionsMenu conversation={conversation}>{items}</ConversationActionsMenu>

      <TicketPickerDialog
        open={open === 'merge'}
        onOpenChange={(next) => {
          if (!next) {
            close();
            setMergeNotice(null);
          }
        }}
        title={t.mergeTitle}
        description={t.mergeDescription}
        exclude={[conversation.id]}
        disabled={merge.isPending}
        notice={mergeNotice ? <InfoBanner variant="warning">{mergeNotice}</InfoBanner> : undefined}
        onPick={onMerge}
      />

      <ConfirmDialog
        open={open === 'unmark'}
        onOpenChange={(next) => !next && close()}
        title={t.unmarkTitle}
        description={t.unmarkDescription.replace('{count}', String(children.length))}
        confirmLabel={t.unmarkIncident}
        loading={setIncident.isPending}
        onConfirm={() => markIncident(false)}
      />

      <ConfirmDialog
        open={open === 'close'}
        onOpenChange={(next) => !next && close()}
        title={t.closeIncidentTitle}
        description={
          openChildren > 0 ? (
            <span className="flex items-center gap-2 pt-2">
              <Checkbox
                id="desk-close-incident-children"
                checked={closeChildren}
                onCheckedChange={(checked) => setCloseChildren(checked === true)}
              />
              <Label htmlFor="desk-close-incident-children" className="font-normal">
                {t.closeChildrenToo.replace('{count}', String(openChildren))}
              </Label>
            </span>
          ) : (
            ''
          )
        }
        confirmLabel={t.closeIncident}
        loading={closeIncident.isPending}
        onConfirm={() =>
          closeIncident.mutate(
            { id: conversation.id, closeChildren: openChildren > 0 && closeChildren },
            { onSuccess: close, onError: () => toast.error(t.saveError) },
          )
        }
      />

      <Dialog open={open === 'update'} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-lg" data-testid="desk-incident-update-dialog">
          <DialogHeader>
            <DialogTitle>{t.postUpdateTitle}</DialogTitle>
            <DialogDescription>{t.postUpdateDescription.replace('{count}', String(openChildren))}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={update}
            onChange={(e) => setUpdate(e.target.value)}
            placeholder={t.postUpdatePlaceholder}
            rows={5}
            maxLength={20_000}
            aria-label={t.postUpdateTitle}
          />
          <DialogFooter>
            <Button onClick={sendUpdate} disabled={!update.trim() || postUpdate.isPending}>
              {postUpdate.isPending ? t.sending : t.send}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
