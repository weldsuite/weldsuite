/** Add/edit shift dialog for the schedule tab. */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrShift, useUpdateHrShift } from '@/hooks/queries/use-weldhr-queries';
import { CompanyPicker, EmployeePicker, ErrorBanner, errorMessage } from '../../components/shared';

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ShiftDialog({
  defaultEmployeeId,
  defaultDate,
  shift,
  onClose,
  onDelete,
  deleting,
}: {
  defaultEmployeeId?: string | null;
  defaultDate?: string;
  shift?: HrShift;
  onClose: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const t = useTranslations();
  const createShift = useCreateHrShift();
  const updateShift = useUpdateHrShift();

  const [employeeId, setEmployeeId] = useState<string | null>(shift?.employeeId ?? defaultEmployeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(shift?.employeeName ?? null);
  const [companyId, setCompanyId] = useState<string | null>(shift?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(shift?.companyName ?? null);
  const [date, setDate] = useState(shift ? shift.startsAt.slice(0, 10) : defaultDate ?? '');
  const [start, setStart] = useState(shift ? timeOf(shift.startsAt) : '09:00');
  const [end, setEnd] = useState(shift ? timeOf(shift.endsAt) : '17:00');
  const [notes, setNotes] = useState(shift?.notes ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createShift.isPending || updateShift.isPending;
  const canSubmit = Boolean(employeeId && date && start && end) && !pending;

  async function submit() {
    if (!employeeId || !date) return;
    setFailure(null);
    try {
      const startsAt = new Date(`${date}T${start}`).toISOString();
      const endsAt = new Date(`${date}T${end}`).toISOString();
      if (shift) {
        await updateShift.mutateAsync({ id: shift.id, companyId, startsAt, endsAt, notes: notes.trim() || null });
      } else {
        await createShift.mutateAsync({ employeeId, companyId, startsAt, endsAt, notes: notes.trim() || null });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.attendance.schedule.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shift ? t('weldhr.attendance.schedule.editShift') : t('weldhr.attendance.schedule.addShift')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label>{t('weldhr.attendance.schedule.form.employee')}</Label>
            <EmployeePicker
              value={employeeId}
              valueLabel={employeeLabel}
              disabled={Boolean(shift)}
              onChange={(id, label) => {
                setEmployeeId(id);
                setEmployeeLabel(label);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.attendance.schedule.form.client')}</Label>
            <CompanyPicker
              value={companyId}
              valueLabel={companyLabel}
              allowClear
              onChange={(id, label) => {
                setCompanyId(id);
                setCompanyLabel(label);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-shift-date">{t('weldhr.attendance.schedule.form.date')}</Label>
            <Input id="hr-shift-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-shift-start">{t('weldhr.attendance.schedule.form.start')}</Label>
              <Input id="hr-shift-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-shift-end">{t('weldhr.attendance.schedule.form.end')}</Label>
              <Input id="hr-shift-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-shift-notes">{t('weldhr.attendance.schedule.form.notes')}</Label>
            <Textarea id="hr-shift-notes" value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {shift && onDelete ? (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={deleting}>
              {t('weldhr.attendance.schedule.deleteShift')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('weldhr.attendance.schedule.form.cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {pending
                ? t('weldhr.attendance.schedule.form.saving')
                : shift
                  ? t('weldhr.attendance.schedule.form.save')
                  : t('weldhr.attendance.schedule.form.create')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
