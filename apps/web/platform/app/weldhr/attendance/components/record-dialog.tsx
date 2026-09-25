/**
 * Add/edit attendance record dialog. Clock in/out are entered as local times
 * and combined with the date into ISO datetimes with the browser's offset.
 */

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
import type { HrAttendanceRecord, HrAttendanceStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrAttendance, useUpdateHrAttendance } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, errorMessage, todayIso } from '../../components/shared';

const STATUSES: HrAttendanceStatus[] = ['present', 'late', 'absent', 'excused', 'remote', 'half_day'];

function timeOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function combine(date: string, time: string): string | null {
  if (!time) return null;
  return new Date(`${date}T${time}`).toISOString();
}

export function AttendanceRecordDialog({
  employeeId: fixedEmployeeId,
  employeeLabel: fixedEmployeeLabel,
  record,
  onClose,
}: Readonly<{
  employeeId?: string;
  employeeLabel?: string | null;
  record?: HrAttendanceRecord;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const createAttendance = useCreateHrAttendance();
  const updateAttendance = useUpdateHrAttendance();

  const [employeeId, setEmployeeId] = useState<string | null>(record?.employeeId ?? fixedEmployeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(record?.employeeName ?? fixedEmployeeLabel ?? null);
  const [date, setDate] = useState(record?.date ?? todayIso());
  const [clockIn, setClockIn] = useState(timeOf(record?.clockIn ?? null));
  const [clockOut, setClockOut] = useState(timeOf(record?.clockOut ?? null));
  const [breakMinutes, setBreakMinutes] = useState(String(record?.breakMinutes ?? 0));
  const [status, setStatus] = useState<HrAttendanceStatus | 'auto'>(record?.status ?? 'auto');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createAttendance.isPending || updateAttendance.isPending;
  const canSubmit = Boolean(employeeId && date) && !pending;

  async function submit() {
    if (!employeeId || !date) return;
    setFailure(null);
    const payload = {
      date,
      clockIn: combine(date, clockIn),
      clockOut: combine(date, clockOut),
      breakMinutes: Number(breakMinutes) || 0,
      status: status === 'auto' ? undefined : status,
      notes: notes.trim() || null,
    };
    try {
      if (record) {
        await updateAttendance.mutateAsync({ id: record.id, ...payload });
      } else {
        await createAttendance.mutateAsync({ employeeId, ...payload });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.attendance.records.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record ? t('weldhr.attendance.records.editRecord') : t('weldhr.attendance.records.addRecord')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          {!fixedEmployeeId && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.attendance.records.form.employee')}</Label>
              <EmployeePicker
                value={employeeId}
                valueLabel={employeeLabel}
                disabled={Boolean(record)}
                onChange={(id, label) => {
                  setEmployeeId(id);
                  setEmployeeLabel(label);
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="hr-att-date">{t('weldhr.attendance.records.form.date')}</Label>
            <Input id="hr-att-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-att-in">{t('weldhr.attendance.records.form.clockIn')}</Label>
              <Input id="hr-att-in" type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-att-out">{t('weldhr.attendance.records.form.clockOut')}</Label>
              <Input id="hr-att-out" type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-att-break">{t('weldhr.attendance.records.form.breakMinutes')}</Label>
              <Input
                id="hr-att-break"
                type="number"
                min={0}
                max={1440}
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.attendance.records.form.status')}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as HrAttendanceStatus | 'auto')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('weldhr.attendance.records.form.autoStatus')}</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`weldhr.status.attendance.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-att-notes">{t('weldhr.attendance.records.form.notes')}</Label>
            <Textarea id="hr-att-notes" value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldhr.attendance.records.form.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {pending
              ? t('weldhr.attendance.records.form.saving')
              : record
                ? t('weldhr.attendance.records.form.save')
                : t('weldhr.attendance.records.form.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
