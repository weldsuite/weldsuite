/** New leave request dialog, filed on behalf of an employee. */

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
import { useCreateHrLeaveRequest, useHrLeaveTypes } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, errorMessage, todayIso } from '../../components/shared';

export function LeaveRequestDialog({
  fixedEmployeeId,
  fixedEmployeeLabel,
  onClose,
}: {
  fixedEmployeeId?: string;
  fixedEmployeeLabel?: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const { data: leaveTypes } = useHrLeaveTypes();
  const createRequest = useCreateHrLeaveRequest();

  const [employeeId, setEmployeeId] = useState<string | null>(fixedEmployeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(fixedEmployeeLabel ?? null);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [daysOverride, setDaysOverride] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const canSubmit = Boolean(employeeId && leaveTypeId && startDate && endDate) && !createRequest.isPending;

  async function submit() {
    if (!employeeId || !leaveTypeId) return;
    setFailure(null);
    try {
      await createRequest.mutateAsync({
        employeeId,
        leaveTypeId,
        startDate,
        endDate,
        days: daysOverride ? Number(daysOverride) : undefined,
        reason: reason.trim() || null,
      });
      onClose();
    } catch (err) {
      const message = errorMessage(err, t('weldhr.leave.requests.form.failed'));
      setFailure(message.toLowerCase().includes('overlap') ? t('weldhr.leave.requests.form.overlap') : message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.leave.requests.form.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          {!fixedEmployeeId && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.leave.requests.form.employee')}</Label>
              <EmployeePicker
                value={employeeId}
                valueLabel={employeeLabel}
                onChange={(id, label) => {
                  setEmployeeId(id);
                  setEmployeeLabel(label);
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t('weldhr.leave.requests.form.type')}</Label>
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('weldhr.leave.requests.form.selectType')} />
              </SelectTrigger>
              <SelectContent>
                {(leaveTypes ?? []).map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-leave-start">{t('weldhr.leave.requests.form.startDate')}</Label>
              <Input id="hr-leave-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-leave-end">{t('weldhr.leave.requests.form.endDate')}</Label>
              <Input id="hr-leave-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-leave-days">{t('weldhr.leave.requests.form.days')}</Label>
            <Input
              id="hr-leave-days"
              type="number"
              min={0.5}
              step={0.5}
              value={daysOverride}
              onChange={(e) => setDaysOverride(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('weldhr.leave.requests.form.daysHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-leave-reason">{t('weldhr.leave.requests.form.reason')}</Label>
            <Textarea id="hr-leave-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldhr.leave.requests.form.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {createRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {createRequest.isPending ? t('weldhr.leave.requests.form.submitting') : t('weldhr.leave.requests.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
