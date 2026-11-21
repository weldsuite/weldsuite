/**
 * The Approval section of the order panel (phase 6): the state of the approval
 * of a B2B order (why it waits, who asked, who decided and when, the comment)
 * and, while it is pending and the member holds `orders:update`, the staff
 * Approve and Reject buttons. An order that never needed approval has no
 * `approval` and the section stays out.
 */

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import type { Order, OrderApproval } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { approvalReasonText, approvalStatusLabel, approvalStatusTone } from '@/app/weldcommerce/lib/orders';
import { approvalActorName } from '@/app/weldcommerce/lib/buyers';
import { SectionHeader, formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { ApprovalDecisionDialog, type ApprovalDecision } from './order-approval-dialogs';

function ApprovalDetails({ approval }: Readonly<{ approval: OrderApproval }>) {
  const t = getTranslations('commerce').orders.approval;
  const decidedAt = formatPanelDate(approval.decidedAt);
  const rows = [
    { label: t.requestedBy, value: approvalActorName(approval.requestedBy) },
    { label: t.decidedBy, value: approvalActorName(approval.decidedBy) },
    { label: t.decidedOn, value: decidedAt },
    { label: t.comment, value: approval.comment?.trim() || null },
  ].filter((row) => row.value);
  if (rows.length === 0) return null;
  return (
    <dl className="space-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words text-right">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalSection({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.approval;
  const permissions = usePermissionsMaybe();
  const canDecide = permissions?.can('orders:update') ?? false;
  const [decision, setDecision] = useState<ApprovalDecision | null>(null);
  const approval = order.approval;
  if (!approval) return null;
  const pending = approval.status === 'pending';

  return (
    <div className="space-y-2">
      <SectionHeader>{t.title}</SectionHeader>
      <div className="mx-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SoftBadge tone={approvalStatusTone(approval.status)}>{approvalStatusLabel(approval.status)}</SoftBadge>
          <span className="min-w-0 text-sm">{approvalReasonText(approval.reason)}</span>
        </div>
        <ApprovalDetails approval={approval} />
        {pending && <p className="text-xs text-muted-foreground">{t.pendingHint}</p>}
        {pending && canDecide && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setDecision('approve')}>
              <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t.approve}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDecision('reject')}>
              <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t.reject}
            </Button>
          </div>
        )}
      </div>
      {decision && (
        <ApprovalDecisionDialog order={order} decision={decision} open onOpenChange={(open) => !open && setDecision(null)} />
      )}
    </div>
  );
}
