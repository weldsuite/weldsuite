/** Add/edit shift dialog for the schedule tab. */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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

/** The local calendar day (`YYYY-MM-DD`) of a UTC instant, matching `timeOf`. */
function dateOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ShiftDialog({
  defaultEmployeeId,
  defaultEmployeeName,
  defaultWorkType,
  defaultDate,
  shift,
  onClose,
  onDelete,
  deleting,
}: Readonly<{
  defaultEmployeeId?: string | null;
  /** Shown for `defaultEmployeeId` until the picker has loaded that employee. */
  defaultEmployeeName?: string | null;
  /** Prefilled type of work for a new shift, e.g. the employee's job title. */
  defaultWorkType?: string | null;
  defaultDate?: string;
  shift?: HrShift;
  onClose: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}>) {
  const t = useTranslations();
  const createShift = useCreateHrShift();
  const updateShift = useUpdateHrShift();

  const [employeeId, setEmployeeId] = useState<string | null>(shift?.employeeId ?? defaultEmployeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(shift?.employeeName ?? defaultEmployeeName ?? null);
  const [companyId, setCompanyId] = useState<string | null>(shift?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(shift?.companyName ?? null);
  const [date, setDate] = useState(shift ? dateOf(shift.startsAt) : defaultDate ?? '');
  const [start, setStart] = useState(shift ? timeOf(shift.startsAt) : '09:00');
  const [end, setEnd] = useState(shift ? timeOf(shift.endsAt) : '17:00');
  const [workType, setWorkType] = useState(shift ? shift.workType ?? '' : defaultWorkType ?? '');
  const [breakStart, setBreakStart] = useState(shift?.breakStartsAt ? timeOf(shift.breakStartsAt) : '');
  const [breakEnd, setBreakEnd] = useState(shift?.breakEndsAt ? timeOf(shift.breakEndsAt) : '');
  const [notes, setNotes] = useState(shift?.notes ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createShift.isPending || updateShift.isPending;
  // A break is optional, but needs both ends and has to sit inside the shift ("HH:mm" compares as text).
  const hasBreak = Boolean(breakStart || breakEnd);
  const breakValid = !hasBreak || (Boolean(breakStart && breakEnd) && start <= breakStart && breakStart < breakEnd && breakEnd <= end);
  const canSubmit = Boolean(employeeId && date && start && end) && breakValid && !pending;

  let submitLabel: string;
  if (pending) submitLabel = t('weldhr.attendance.schedule.form.saving');
  else if (shift) submitLabel = t('weldhr.attendance.schedule.form.save');
  else submitLabel = t('weldhr.attendance.schedule.form.create');

  async function submit() {
    if (!employeeId || !date) return;
    setFailure(null);
    try {
      const startsAt = new Date(`${date}T${start}`).toISOString();
      const endsAt = new Date(`${date}T${end}`).toISOString();
      const details = {
        companyId,
        startsAt,
        endsAt,
        workType: workType.trim() || null,
        breakStartsAt: hasBreak ? new Date(`${date}T${breakStart}`).toISOString() : null,
        breakEndsAt: hasBreak ? new Date(`${date}T${breakEnd}`).toISOString() : null,
        notes: notes.trim() || null,
      };
      if (shift) {
        await updateShift.mutateAsync({ id: shift.id, ...details });
      } else {
        await createShift.mutateAsync({ employeeId, ...details });
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
            <Label htmlFor="hr-shift-work-type">{t('weldhr.attendance.schedule.form.workType')}</Label>
            <Input
              id="hr-shift-work-type"
              value={workType}
              maxLength={100}
              placeholder={t('weldhr.attendance.schedule.form.workTypePlaceholder')}
              onChange={(e) => setWorkType(e.target.value)}
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hr-shift-break-start">{t('weldhr.attendance.schedule.form.breakStart')}</Label>
                <Input
                  id="hr-shift-break-start"
                  type="time"
                  value={breakStart}
                  aria-invalid={!breakValid}
                  onChange={(e) => setBreakStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hr-shift-break-end">{t('weldhr.attendance.schedule.form.breakEnd')}</Label>
                <Input
                  id="hr-shift-break-end"
                  type="time"
                  value={breakEnd}
                  aria-invalid={!breakValid}
                  onChange={(e) => setBreakEnd(e.target.value)}
                />
              </div>
            </div>
            {!breakValid && <p className="text-xs text-destructive">{t('weldhr.attendance.schedule.form.breakInvalid')}</p>}
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
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
