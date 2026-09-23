/** Add or edit a client assignment for one employee. */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrAssignment } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrAssignment, useUpdateHrAssignment } from '@/hooks/queries/use-weldhr-queries';
import { CompanyPicker, ErrorBanner, errorMessage, todayIso } from '../../components/shared';

export function AssignmentDialog({
  employeeId,
  assignment,
  onClose,
}: {
  employeeId: string;
  assignment?: HrAssignment;
  onClose: () => void;
}) {
  const t = useTranslations();
  const createAssignment = useCreateHrAssignment();
  const updateAssignment = useUpdateHrAssignment();
  const isEdit = Boolean(assignment);

  const [companyId, setCompanyId] = useState<string | null>(assignment?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(assignment?.companyName ?? null);
  const [role, setRole] = useState(assignment?.role ?? '');
  const [allocationPercent, setAllocationPercent] = useState(String(assignment?.allocationPercent ?? 100));
  const [isPrimary, setIsPrimary] = useState(assignment?.isPrimary ?? false);
  const [startDate, setStartDate] = useState(assignment?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(assignment?.endDate ?? '');
  const [notes, setNotes] = useState(assignment?.notes ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const isSubmitting = createAssignment.isPending || updateAssignment.isPending;

  async function submit() {
    if (!isEdit && !companyId) return;
    setFailure(null);
    try {
      const allocation = allocationPercent === '' ? undefined : Number(allocationPercent);
      if (isEdit && assignment) {
        await updateAssignment.mutateAsync({
          id: assignment.id,
          role: role.trim() || null,
          allocationPercent: allocation,
          isPrimary,
          startDate,
          endDate: endDate || null,
          notes: notes.trim() || null,
        });
      } else if (companyId) {
        await createAssignment.mutateAsync({
          employeeId,
          companyId,
          role: role.trim() || null,
          allocationPercent: allocation,
          isPrimary,
          startDate,
          endDate: endDate || null,
          notes: notes.trim() || null,
        });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.detail.clientsTab.assignmentForm.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('weldhr.employees.detail.clientsTab.assignmentForm.editTitle')
              : t('weldhr.employees.detail.clientsTab.assignmentForm.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div className="space-y-1.5">
            <Label>{t('weldhr.employees.detail.clientsTab.assignmentForm.client')}</Label>
            <CompanyPicker value={companyId} valueLabel={companyLabel} onChange={(id, label) => { setCompanyId(id); setCompanyLabel(label); }} disabled={isEdit} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('weldhr.employees.detail.clientsTab.assignmentForm.role')}</Label>
              <Input value={role} onChange={(e) => setRole(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.employees.detail.clientsTab.assignmentForm.allocation')}</Label>
              <Input type="number" min={0} max={100} value={allocationPercent} onChange={(e) => setAllocationPercent(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.from')}</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.to')}</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(Boolean(v))} />
            {t('weldhr.employees.detail.clientsTab.assignmentForm.primary')}
          </label>

          <div className="space-y-1.5">
            <Label>{t('weldhr.common.notes')}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={isSubmitting || (!isEdit && !companyId)}>
            {isSubmitting ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
