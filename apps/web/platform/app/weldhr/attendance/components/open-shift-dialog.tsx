/** Post/edit dialog for an open shift: a shift without an employee that people sign up for. */

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrOpenShift, useHrDepartments, useUpdateHrOpenShift } from '@/hooks/queries/use-weldhr-queries';
import { CompanyPicker, ErrorBanner, errorMessage, instantAt } from '../../components/shared';
import { dateOf, shiftWindow, timeOf } from './shift-dialog';

/** Value of the department select that means "everyone". */
const EVERYONE = '__everyone';
const MAX_SPOTS = 100;

export function OpenShiftDialog({ shift, onClose }: Readonly<{ shift?: HrOpenShift; onClose: () => void }>) {
  const t = useTranslations();
  const createShift = useCreateHrOpenShift();
  const updateShift = useUpdateHrOpenShift();
  const { data: departments } = useHrDepartments();

  const [companyId, setCompanyId] = useState<string | null>(shift?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(shift?.companyName ?? null);
  const [departmentId, setDepartmentId] = useState<string>(shift?.departmentId ?? EVERYONE);
  const [date, setDate] = useState(shift ? dateOf(shift.startsAt) : '');
  const [start, setStart] = useState(shift ? timeOf(shift.startsAt) : '09:00');
  const [end, setEnd] = useState(shift ? timeOf(shift.endsAt) : '17:00');
  const [workType, setWorkType] = useState(shift?.workType ?? '');
  const [breakStart, setBreakStart] = useState(shift?.breakStartsAt ? timeOf(shift.breakStartsAt) : '');
  const [breakEnd, setBreakEnd] = useState(shift?.breakEndsAt ? timeOf(shift.breakEndsAt) : '');
  const [spots, setSpots] = useState(String(shift?.spots ?? 1));
  const [notes, setNotes] = useState(shift?.notes ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  // Once someone is approved the server keeps the times fixed (their shift moves on the rooster instead).
  const filled = shift?.filled ?? 0;
  const timesLocked = filled > 0;
  const minSpots = Math.max(1, filled);
  const spotCount = Number(spots);
  const spotsValid = Number.isInteger(spotCount) && spotCount >= minSpots && spotCount <= MAX_SPOTS;

  const pending = createShift.isPending || updateShift.isPending;
  const { shiftMinutes, endsNextDay, offset, hasBreak, breakValid } = shiftWindow(start, end, breakStart, breakEnd);
  const canSubmit = Boolean(date && start && end) && breakValid && spotsValid && !pending;

  let submitLabel: string;
  if (pending) submitLabel = t('weldhr.attendance.openShifts.form.saving');
  else if (shift) submitLabel = t('weldhr.attendance.openShifts.form.save');
  else submitLabel = t('weldhr.attendance.openShifts.form.create');

  async function submit() {
    if (!date) return;
    setFailure(null);
    try {
      const details = {
        companyId,
        departmentId: departmentId === EVERYONE ? null : departmentId,
        workType: workType.trim() || null,
        notes: notes.trim() || null,
        spots: spotCount,
      };
      const times = {
        startsAt: instantAt(date, start),
        endsAt: instantAt(date, start, shiftMinutes),
        breakStartsAt: hasBreak ? instantAt(date, start, offset(breakStart)) : null,
        breakEndsAt: hasBreak ? instantAt(date, start, offset(breakEnd)) : null,
      };
      if (shift) {
        await updateShift.mutateAsync({ id: shift.id, ...details, ...(timesLocked ? {} : times) });
      } else {
        await createShift.mutateAsync({ ...details, ...times });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.attendance.openShifts.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{shift ? t('weldhr.attendance.openShifts.editTitle') : t('weldhr.attendance.openShifts.addTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="hr-open-shift-work-type">{t('weldhr.attendance.openShifts.form.workType')}</Label>
            <Input
              id="hr-open-shift-work-type"
              value={workType}
              maxLength={100}
              placeholder={t('weldhr.attendance.openShifts.form.workTypePlaceholder')}
              onChange={(e) => setWorkType(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.attendance.openShifts.form.client')}</Label>
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
            <Label>{t('weldhr.attendance.openShifts.form.department')}</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERYONE}>{t('weldhr.attendance.openShifts.everyone')}</SelectItem>
                {(departments ?? []).map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('weldhr.attendance.openShifts.form.departmentHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-open-shift-date">{t('weldhr.attendance.openShifts.form.date')}</Label>
            <Input id="hr-open-shift-date" type="date" value={date} disabled={timesLocked} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-open-shift-start">{t('weldhr.attendance.openShifts.form.start')}</Label>
              <Input id="hr-open-shift-start" type="time" value={start} disabled={timesLocked} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-open-shift-end">{t('weldhr.attendance.openShifts.form.end')}</Label>
              <Input id="hr-open-shift-end" type="time" value={end} disabled={timesLocked} onChange={(e) => setEnd(e.target.value)} />
              {endsNextDay && <p className="text-xs text-muted-foreground">{t('weldhr.attendance.openShifts.form.nextDay')}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hr-open-shift-break-start">{t('weldhr.attendance.openShifts.form.breakStart')}</Label>
                <Input
                  id="hr-open-shift-break-start"
                  type="time"
                  value={breakStart}
                  disabled={timesLocked}
                  aria-invalid={!breakValid}
                  onChange={(e) => setBreakStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hr-open-shift-break-end">{t('weldhr.attendance.openShifts.form.breakEnd')}</Label>
                <Input
                  id="hr-open-shift-break-end"
                  type="time"
                  value={breakEnd}
                  disabled={timesLocked}
                  aria-invalid={!breakValid}
                  onChange={(e) => setBreakEnd(e.target.value)}
                />
              </div>
            </div>
            {!breakValid && <p className="text-xs text-destructive">{t('weldhr.attendance.openShifts.form.breakInvalid')}</p>}
            {timesLocked && <p className="text-xs text-muted-foreground">{t('weldhr.attendance.openShifts.form.timesLocked')}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-open-shift-spots">{t('weldhr.attendance.openShifts.form.spots')}</Label>
            <Input
              id="hr-open-shift-spots"
              type="number"
              inputMode="numeric"
              min={minSpots}
              max={MAX_SPOTS}
              value={spots}
              aria-invalid={!spotsValid}
              className="w-28"
              onChange={(e) => setSpots(e.target.value)}
            />
            {filled > 0 && <p className="text-xs text-muted-foreground">{t('weldhr.attendance.openShifts.form.spotsHint', { count: filled })}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-open-shift-notes">{t('weldhr.attendance.openShifts.form.notes')}</Label>
            <Textarea id="hr-open-shift-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('weldhr.attendance.openShifts.form.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
