/** Start an onboarding or offboarding checklist on an employee, from a template. */

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useHrChecklistTemplates,
  useStartHrChecklist,
  useUpdateHrEmployee,
} from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';

export function LifecycleStartDialog({
  employeeId,
  kind,
  onClose,
}: Readonly<{
  employeeId: string;
  kind: 'onboarding' | 'offboarding';
  onClose: () => void;
}>) {
  const t = useTranslations();
  const { data: templates, isLoading } = useHrChecklistTemplates(kind);
  const startChecklist = useStartHrChecklist();
  const updateEmployee = useUpdateHrEmployee();
  const defaultTemplateId = templates?.find((tpl) => tpl.isDefault)?.id ?? templates?.[0]?.id;
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [lastWorkingDay, setLastWorkingDay] = useState(todayIso());
  const [failure, setFailure] = useState<string | null>(null);

  const selectedTemplateId = templateId ?? defaultTemplateId;
  const isSubmitting = startChecklist.isPending || updateEmployee.isPending;

  async function submit() {
    if (!selectedTemplateId) return;
    setFailure(null);
    try {
      if (kind === 'offboarding' && lastWorkingDay) {
        await updateEmployee.mutateAsync({ id: employeeId, endDate: lastWorkingDay });
      }
      await startChecklist.mutateAsync({
        employeeId,
        templateId: selectedTemplateId,
        anchorDate: kind === 'offboarding' ? lastWorkingDay || undefined : undefined,
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.detail.lifecycleDialog.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === 'onboarding'
              ? t('weldhr.employees.detail.lifecycleDialog.onboardingTitle')
              : t('weldhr.employees.detail.lifecycleDialog.offboardingTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          {!isLoading && (templates ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.employees.detail.lifecycleDialog.noTemplates')}</p>
          ) : (
            <div className="space-y-1.5">
              <Label>{t('weldhr.employees.detail.lifecycleDialog.template')}</Label>
              <Select value={selectedTemplateId} onValueChange={setTemplateId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(templates ?? []).map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === 'offboarding' && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.employees.detail.lifecycleDialog.lastWorkingDay')}</Label>
              <Input type="date" value={lastWorkingDay} onChange={(e) => setLastWorkingDay(e.target.value)} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={isSubmitting || !selectedTemplateId}>
            {isSubmitting ? t('weldhr.common.saving') : t('weldhr.common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
