/**
 * The Buyers tab of the company panel (phase 6, WeldCommerce): the people of
 * the company who may order from the B2B sales channels, with their role,
 * spend limit and status, and the company's approval threshold. Reading needs
 * `companies:read` (the panel only shows the tab then); inviting, editing,
 * re-inviting, removing and the threshold need `companies:update`.
 */

import { useState, type ReactNode } from 'react';
import { EllipsisVertical, Pencil, Plus, Send, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import {
  useCommerceBuyers,
  useDeleteCommerceBuyer,
  useResendCommerceBuyerInvite,
  type Buyer,
} from '@/hooks/queries/use-commerce-buyers-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import {
  buyerDisplayName,
  buyerErrorMessage,
  buyerRoleLabel,
  buyerStatusLabel,
  buyerStatusTone,
} from '@/app/weldcommerce/lib/buyers';
import { money } from '@/app/weldcommerce/lib/orders';
import { fill } from '@/app/weldcommerce/lib/text';
import { ApprovalThreshold } from './company-approval-threshold';
import { EditBuyerDialog, InviteBuyerDialog } from './company-buyer-dialogs';

function limitText(buyer: Buyer): string {
  const t = getTranslations('commerce').buyers.spendLimit;
  return buyer.spendLimit ? fill(t.perOrder, { amount: money(buyer.spendLimit, buyer.spendLimitCurrency) }) : t.none;
}

function datesText(buyer: Buyer): string {
  const t = getTranslations('commerce').buyers;
  const invited = formatPanelDate(buyer.invitedAt);
  const accepted = formatPanelDate(buyer.acceptedAt);
  return [invited && fill(t.invitedOn, { date: invited }), accepted && fill(t.acceptedOn, { date: accepted })]
    .filter(Boolean)
    .join(' · ');
}

function BuyerMenu({
  buyer,
  onEdit,
  onResend,
  onRemove,
}: Readonly<{ buyer: Buyer; onEdit: () => void; onResend: () => void; onRemove: () => void }>) {
  const t = getTranslations('commerce').buyers.actions;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label={fill(t.menu, { name: buyerDisplayName(buyer) })}>
          <EllipsisVertical className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil />
          {t.edit}
        </DropdownMenuItem>
        {buyer.status === 'invited' && (
          <DropdownMenuItem onClick={onResend}>
            <Send />
            {t.resend}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash2 />
          {t.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BuyerRow({
  buyer,
  canEdit,
  onEdit,
  onResend,
  onRemove,
}: Readonly<{ buyer: Buyer; canEdit: boolean; onEdit: () => void; onResend: () => void; onRemove: () => void }>) {
  const dates = datesText(buyer);
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 space-y-1.5">
        <p className="truncate text-sm font-medium">{buyerDisplayName(buyer)}</p>
        {buyer.name?.trim() && <p className="truncate text-xs text-muted-foreground">{buyer.email}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          <SoftBadge tone="neutral">{buyerRoleLabel(buyer.role)}</SoftBadge>
          <SoftBadge tone={buyerStatusTone(buyer.status)}>{buyerStatusLabel(buyer.status)}</SoftBadge>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{limitText(buyer)}</p>
        {dates && <p className="text-xs text-muted-foreground">{dates}</p>}
      </div>
      {canEdit && <BuyerMenu buyer={buyer} onEdit={onEdit} onResend={onResend} onRemove={onRemove} />}
    </li>
  );
}

export function CompanyBuyersTab({ companyId, companyName }: Readonly<{ companyId: string; companyName: string }>) {
  const t = getTranslations('commerce').buyers;
  const permissions = usePermissionsMaybe();
  const canEdit = permissions?.can('companies:update') ?? false;
  const buyers = useCommerceBuyers({ companyId });
  const resend = useResendCommerceBuyerInvite();
  const remove = useDeleteCommerceBuyer();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Buyer | null>(null);
  const [removing, setRemoving] = useState<Buyer | null>(null);

  const resendInvite = async (buyer: Buyer) => {
    try {
      await resend.mutateAsync(buyer.id);
      toast.success(fill(t.toastResent, { email: buyer.email }));
    } catch (err) {
      toast.error(buyerErrorMessage(err, t.errors.generic));
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success(t.removeDialog.toast);
      setRemoving(null);
    } catch (err) {
      // LAST_ADMIN and friends: said in words, and the confirmation stays up to cancel.
      toast.error(buyerErrorMessage(err, t.errors.generic));
    }
  };

  const list = buyers.data?.data ?? [];
  const inviteButton = canEdit ? (
    <Button type="button" size="sm" onClick={() => setInviting(true)}>
      <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
      {t.invite}
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (buyers.isPending) body = <InlineSpinner className="py-6" />;
  else if (buyers.isError) body = <ErrorState message={t.loadFailed} onRetry={() => void buyers.refetch()} />;
  else if (list.length === 0) body = <EmptyState icon={Users} title={t.empty} description={t.emptyDescription} action={inviteButton} />;
  else
    body = (
      <ul className="space-y-2">
        {list.map((buyer) => (
          <BuyerRow
            key={buyer.id}
            buyer={buyer}
            canEdit={canEdit}
            onEdit={() => setEditing(buyer)}
            onResend={() => void resendInvite(buyer)}
            onRemove={() => setRemoving(buyer)}
          />
        ))}
      </ul>
    );

  return (
    <div className="space-y-6 p-4">
      <section aria-labelledby="company-buyers-title" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 id="company-buyers-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t.title}
            </h3>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {list.length > 0 && inviteButton}
        </div>
        {body}
      </section>
      <ApprovalThreshold companyId={companyId} canEdit={canEdit} />

      {inviting && <InviteBuyerDialog companyId={companyId} companyName={companyName} open onOpenChange={(open) => !open && setInviting(false)} />}
      {editing && <EditBuyerDialog buyer={editing} open onOpenChange={(open) => !open && setEditing(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        variant="destructive"
        title={fill(t.removeDialog.title, { name: removing ? buyerDisplayName(removing) : '' })}
        description={fill(t.removeDialog.description, { name: removing ? buyerDisplayName(removing) : '' })}
        confirmLabel={t.removeDialog.confirm}
        cancelLabel={t.removeDialog.keep}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
