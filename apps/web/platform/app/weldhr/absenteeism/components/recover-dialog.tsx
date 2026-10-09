/**
 * Report recovered: close an open sick report on its last sick day. Used by an
 * employee for their own report (`self`) and by HR for anyone's.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import { useMyHrReportRecovered, useRecoverHrAbsence } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, formatDate, todayIso } from '../../components/shared';
import { absenceFailure, suggestedLastSickDay } from './shared';

export function RecoverDialog({
  absence,
  employeeName,
  self,
  onClose,
}: Readonly<{
  absence: { id: string; startDate: string };
  /** Shown when HR closes someone else's report. */
  employeeName?: string;
  self?: boolean;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const reportRecovered = useMyHrReportRecovered();
  const recoverAbsence = useRecoverHrAbsence();
  const [endDate, setEndDate] = useState(() => suggestedLastSickDay(absence.startDate));
  const [failure, setFailure] = useState<string | null>(null);

  const isSubmitting = reportRecovered.isPending || recoverAbsence.isPending;
  const today = todayIso();
  let invalid: string | null = null;
  if (!endDate) invalid = t('weldhr.absenteeism.form.errors.date');
  else if (endDate < absence.startDate) invalid = t('weldhr.absenteeism.form.errors.endBeforeStart');
  else if (self && endDate > today) invalid = t('weldhr.absenteeism.form.errors.future');

  async function submit() {
    if (invalid) return;
    setFailure(null);
    try {
      if (self) {
        await reportRecovered.mutateAsync({ id: absence.id, endDate });
        toast.success(t('weldhr.absenteeism.form.recoveredToast'));
      } else {
        await recoverAbsence.mutateAsync({ id: absence.id, endDate });
      }
      onClose();
    } catch (err) {
      setFailure(absenceFailure(err, t));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.absenteeism.form.recoverTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <p className="text-sm text-muted-foreground">
            {employeeName && <span className="font-medium text-foreground">{employeeName} · </span>}
            {t('weldhr.absenteeism.since', { date: formatDate(absence.startDate) })}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="hr-absence-last-day">{t('weldhr.absenteeism.form.lastSickDay')}</Label>
            <Input
              id="hr-absence-last-day"
              type="date"
              min={absence.startDate}
              max={self ? today : undefined}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              aria-invalid={Boolean(invalid)}
            />
            <p className={invalid ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
              {invalid ?? t('weldhr.absenteeism.form.lastSickDayHint')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={isSubmitting || Boolean(invalid)}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.absenteeism.reportRecovered')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
