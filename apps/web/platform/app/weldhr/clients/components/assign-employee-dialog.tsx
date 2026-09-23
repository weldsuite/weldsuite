/** Start a new client account by assigning an employee to a CRM company. */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCreateHrAssignment } from '@/hooks/queries/use-weldhr-queries';
import { CompanyPicker, EmployeePicker, ErrorBanner, errorMessage, todayIso } from '../../components/shared';

export function AssignEmployeeDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const createAssignment = useCreateHrAssignment();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [role, setRole] = useState('');
  const [startDate, setStartDate] = useState(todayIso());
  const [failure, setFailure] = useState<string | null>(null);

  const canSubmit = Boolean(employeeId && companyId && startDate);

  async function submit() {
    if (!employeeId || !companyId) return;
    setFailure(null);
    try {
      await createAssignment.mutateAsync({
        employeeId,
        companyId,
        role: role.trim() || null,
        startDate,
        isPrimary: true,
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.clients.assign.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !createAssignment.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.clients.assign.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div className="space-y-1.5">
            <Label>{t('weldhr.clients.assign.employee')}</Label>
            <EmployeePicker value={employeeId} valueLabel={employeeLabel} onChange={(id, label) => { setEmployeeId(id); setEmployeeLabel(label); }} />
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.clients.assign.client')}</Label>
            <CompanyPicker value={companyId} valueLabel={companyLabel} onChange={(id, label) => { setCompanyId(id); setCompanyLabel(label); }} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('weldhr.clients.assign.role')}</Label>
              <Input value={role} onChange={(e) => setRole(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.clients.assign.startDate')}</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={createAssignment.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit || createAssignment.isPending}>
            {createAssignment.isPending ? t('weldhr.common.saving') : t('weldhr.clients.assign.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
