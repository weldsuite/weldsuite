import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useUpdateAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { invalidateForm1099Review } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useI18n } from '@/lib/i18n/provider';

interface BackupWithholdingButtonProps {
  partyId: string;
  vendorName: string;
  size?: 'sm' | 'xs';
}

/**
 * "Turn on backup withholding" for a vendor whose TIN the IRS could not match.
 * Asks first: from then on 24% is withheld from the vendor's payments.
 */
export function BackupWithholdingButton({ partyId, vendorName, size = 'sm' }: Readonly<BackupWithholdingButtonProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksUs.form1099.backupWithholding;
  const { can } = usePermissions();
  const qc = useQueryClient();
  const update = useUpdateAccountingCustomer();
  const [open, setOpen] = useState(false);

  if (!can('invoices:update')) return null;

  const confirm = async () => {
    try {
      await update.mutateAsync({ id: partyId, data: { backupWithholding: true } });
      invalidateForm1099Review(qc);
      toast.success(tb.turnedOn.replace('{name}', vendorName));
      setOpen(false);
    } catch (err) {
      toast.error(tb.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}>
        {tb.turnOn}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tb.confirmTitle.replace('{name}', vendorName)}
        description={tb.confirmDescription}
        confirmLabel={tb.confirm}
        cancelLabel={tb.cancel}
        loading={update.isPending}
        onConfirm={confirm}
      />
    </>
  );
}
