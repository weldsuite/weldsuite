/** Employee Payroll tab — masked identity and bank details; HR can edit them and record the ID check. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, ShieldAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { useSetHrPayrollPaymentDetails } from '@/hooks/queries/use-weldhr-payroll-queries';
import { SectionCard } from '../../components/page-kit';
import { errorMessage } from '../../components/shared';
import { PaymentDetailsForm } from '../components/payment-details-form';
import { PaymentDetailsView } from '../components/payment-details-view';

export function PaymentDetailsCard({ employeeId, detail, canEdit }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = useSetHrPayrollPaymentDetails();
  const country = detail.employer?.country;
  if (!country) return null;

  return (
    <SectionCard
      title={t('weldhr.payroll.details.title')}
      action={
        canEdit && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 h-4 w-4" />
            {t('weldhr.common.edit')}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('weldhr.payroll.details.encryptedNotice')}
        </p>
        <PaymentDetailsView country={country} details={detail.paymentDetails} />
      </div>

      {editing && (
        <Dialog open onOpenChange={(open) => !open && !save.isPending && setEditing(false)}>
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('weldhr.payroll.details.editTitle')}</DialogTitle>
              <DialogDescription>{t('weldhr.payroll.details.editDescriptionHr')}</DialogDescription>
            </DialogHeader>
            <PaymentDetailsForm
              country={country}
              details={detail.paymentDetails}
              isHr
              saving={save.isPending}
              failure={failure}
              onCancel={() => setEditing(false)}
              onSubmit={async (values) => {
                setFailure(null);
                try {
                  await save.mutateAsync({ employeeId, ...values });
                  toast.success(t('weldhr.payroll.details.saved'));
                  setEditing(false);
                } catch (err) {
                  setFailure(errorMessage(err, t('weldhr.payroll.details.saveFailed')));
                }
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </SectionCard>
  );
}
