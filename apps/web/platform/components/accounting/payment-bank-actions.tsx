/**
 * What an invoice's or bill's Payments tab can do with a bank transaction
 * (edition feature `books-bank-links`): link one ("Link bank transaction"),
 * undo a payment's bank match, or delete a payment no bank transaction
 * confirms. Hands the tab a toolbar button, a row menu per payment and the
 * dialogs they open.
 */
import { useState, type ReactNode } from 'react';
import { Link2, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { useUnreconcileBankLine, useVoidPayment } from '@/hooks/queries/use-weldbooks-banking-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { LinkBankLineDialog, type LinkableDocument } from './link-bank-line-dialog';

interface BankLinkedPayment {
  id: string;
  bankTransactionId?: string | null;
}

type Pending = { kind: 'undo'; lineId: string } | { kind: 'delete'; paymentId: string };

export interface PaymentBankActions {
  /** Whether the edition offers it at all. */
  available: boolean;
  /** The "Link bank transaction" button, while the document can take a payment. */
  linkButton: ReactNode;
  /** The row menu items of a payment, or undefined when there are none. */
  menuFor: (payment: BankLinkedPayment) => ReactNode | undefined;
  /** The dialogs; render once in the tab. */
  dialogs: ReactNode;
}

/** `canLink`: the document still has money open and is not a draft. */
export function usePaymentBankActions(document: LinkableDocument, canLink: boolean): PaymentBankActions {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
  const available = isFeatureAvailable('books-bank-links');
  const [linkOpen, setLinkOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const unreconcile = useUnreconcileBankLine();
  const voidPayment = useVoidPayment();

  const canMatch = useCan('banking:update') && available;
  const canDelete = useCan('banking:delete') && available;

  const linkButton =
    canMatch && canLink ? (
      <Button type="button" variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
        <Link2 className="mr-1 h-4 w-4" />
        {tl.linkAction}
      </Button>
    ) : null;

  const menuFor = (payment: BankLinkedPayment) => {
    if (payment.bankTransactionId) {
      const lineId = payment.bankTransactionId;
      return canMatch ? (
        <DropdownMenuItem onClick={() => setPending({ kind: 'undo', lineId })}>
          <Unlink />
          {tl.undoMatch}
        </DropdownMenuItem>
      ) : undefined;
    }
    return canDelete ? (
      <DropdownMenuItem variant="destructive" onClick={() => setPending({ kind: 'delete', paymentId: payment.id })}>
        <Trash2 />
        {tl.deletePayment}
      </DropdownMenuItem>
    ) : undefined;
  };

  const confirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'undo') {
        await unreconcile.mutateAsync(pending.lineId);
        toast.success(tl.undone);
      } else {
        await voidPayment.mutateAsync(pending.paymentId);
        toast.success(tl.deleted);
      }
      setPending(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const undo = pending?.kind === 'undo';
  const dialogs = available ? (
    <>
      <LinkBankLineDialog document={document} open={linkOpen} onOpenChange={setLinkOpen} />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={undo ? tl.undoTitle : tl.deleteTitle}
        description={undo ? tl.undoDescription : tl.deleteDescription}
        confirmLabel={undo ? tl.undoMatch : tl.deletePayment}
        variant="destructive"
        loading={unreconcile.isPending || voidPayment.isPending}
        onConfirm={confirm}
      />
    </>
  ) : null;

  return { available, linkButton, menuFor, dialogs };
}
