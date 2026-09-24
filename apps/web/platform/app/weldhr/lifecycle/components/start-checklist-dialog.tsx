/** "Start checklist" dialog: pick an employee, a template, and an optional anchor date. */

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
import { useTranslations } from '@weldsuite/i18n/client';
import { useHrChecklistTemplates, useStartHrChecklist } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, errorMessage } from '../../components/shared';

export function StartChecklistDialog({
  kind: fixedKind,
  onClose,
  fixedEmployeeId,
  fixedEmployeeLabel,
}: {
  /** When known ahead of time (e.g. the employee's own lifecycle tab), the Type picker is skipped. */
  kind?: 'onboarding' | 'offboarding';
  onClose: () => void;
  /** When starting from an employee's own lifecycle tab, the employee is already known. */
  fixedEmployeeId?: string;
  fixedEmployeeLabel?: string | null;
}) {
  const t = useTranslations();
  const [kind, setKind] = useState<'onboarding' | 'offboarding'>(fixedKind ?? 'onboarding');
  const { data: templates, isLoading: templatesLoading } = useHrChecklistTemplates(kind);
  const startChecklist = useStartHrChecklist();

  const [employeeId, setEmployeeId] = useState<string | null>(fixedEmployeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(fixedEmployeeLabel ?? null);
  const [templateId, setTemplateId] = useState('');
  const [anchorDate, setAnchorDate] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const canSubmit = Boolean(employeeId && templateId) && !startChecklist.isPending;

  async function submit() {
    if (!employeeId || !templateId) return;
    setFailure(null);
    try {
      await startChecklist.mutateAsync({ employeeId, templateId, anchorDate: anchorDate || undefined });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.lifecycle.startChecklist.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.lifecycle.startChecklist.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          {!fixedKind && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.lifecycle.startChecklist.kind')}</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as 'onboarding' | 'offboarding');
                  setTemplateId('');
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="onboarding">{t('weldhr.status.checklistKind.onboarding')}</SelectItem>
                  <SelectItem value="offboarding">{t('weldhr.status.checklistKind.offboarding')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {!fixedEmployeeId && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.lifecycle.startChecklist.employee')}</Label>
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
            <Label>{t('weldhr.lifecycle.startChecklist.template')}</Label>
            <Select value={templateId} onValueChange={setTemplateId} disabled={templatesLoading}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('weldhr.lifecycle.startChecklist.selectTemplate')} />
              </SelectTrigger>
              <SelectContent>
                {(templates ?? []).length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    {t('weldhr.lifecycle.startChecklist.noTemplates', { kind })}
                  </div>
                ) : (
                  (templates ?? []).map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-checklist-anchor-date">{t('weldhr.lifecycle.startChecklist.anchorDate')}</Label>
            <Input
              id="hr-checklist-anchor-date"
              type="date"
              value={anchorDate}
              onChange={(event) => setAnchorDate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('weldhr.lifecycle.startChecklist.anchorDateHint')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {startChecklist.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {startChecklist.isPending ? t('weldhr.lifecycle.startChecklist.submitting') : t('weldhr.lifecycle.startChecklist.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
