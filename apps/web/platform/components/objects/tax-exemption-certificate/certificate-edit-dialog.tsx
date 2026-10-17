import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useUpdateExemptionCertificate } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { CertificateForm } from '@/app/weldbooks/sales-tax/certificates/certificate-form';
import { certificateToForm, toUpdateCertificateInput } from '@/app/weldbooks/sales-tax/certificates/certificate-model';
import { CustomerName } from '@/app/weldbooks/sales-tax/setup/customer-picker';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';

/** Edit what was recorded on a certificate. The customer never changes. */
/** The server's reason a save failed, else the generic message. */
function saveErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function CertificateEditDialog({
  certificate,
  open,
  onOpenChange,
}: Readonly<{ certificate: ExemptionCertificate; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useSetupTexts();
  const update = useUpdateExemptionCertificate();

  const close = () => {
    update.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.certificates.form.editTitle}</DialogTitle>
          <DialogDescription asChild>
            <p>
              <CustomerName partyId={certificate.partyId} />
            </p>
          </DialogDescription>
        </DialogHeader>
        <CertificateForm
          mode="edit"
          initial={certificateToForm(certificate)}
          lockCustomer
          submitting={update.isPending}
          submitError={update.isError ? saveErrorMessage(update.error, t.certificates.form.saveError) : null}
          onCancel={close}
          onSubmit={async (values) => {
            try {
              await update.mutateAsync({ id: certificate.id, input: toUpdateCertificateInput(values) });
              toast.success(t.certificates.detail.saved);
              onOpenChange(false);
            } catch {
              // The error shows under the form (update.error).
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
