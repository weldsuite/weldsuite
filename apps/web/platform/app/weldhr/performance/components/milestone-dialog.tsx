/** Create or edit a goal / milestone / certification for an employee. */

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
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  HrMilestone,
  HrMilestoneStatus,
  HrMilestoneType,
} from '@weldsuite/app-api-client/domains/weldhr';
import {
  useCreateHrMilestone,
  useUpdateHrMilestone,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  ErrorBanner,
  errorMessage,
} from '../../components/shared';

const TYPES: HrMilestoneType[] = ['goal', 'milestone', 'certification'];
const STATUSES: HrMilestoneStatus[] = ['planned', 'in_progress', 'achieved', 'missed'];

export function MilestoneDialog({
  milestone,
  employeeId: lockedEmployeeId,
  employeeLabel: lockedEmployeeLabel,
  onClose,
}: {
  milestone?: HrMilestone | null;
  employeeId?: string;
  employeeLabel?: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const isEdit = Boolean(milestone);
  const createMilestone = useCreateHrMilestone();
  const updateMilestone = useUpdateHrMilestone();

  const [empId, setEmpId] = useState<string | null>(milestone?.employeeId ?? lockedEmployeeId ?? null);
  const [empLabel, setEmpLabel] = useState<string | null>(milestone?.employeeName ?? lockedEmployeeLabel ?? null);
  const [companyId, setCompanyId] = useState<string | null>(milestone?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(milestone?.companyName ?? null);
  const [title, setTitle] = useState(milestone?.title ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [type, setType] = useState<HrMilestoneType>(milestone?.type ?? 'goal');
  const [status, setStatus] = useState<HrMilestoneStatus>(milestone?.status ?? 'planned');
  const [dueDate, setDueDate] = useState(milestone?.dueDate ?? '');
  const [achievedAt, setAchievedAt] = useState(milestone?.achievedAt ?? '');
  const [sharedWithClient, setSharedWithClient] = useState(milestone?.sharedWithClient ?? false);
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createMilestone.isPending || updateMilestone.isPending;

  async function submit() {
    if (!empId || !title.trim()) return;
    setFailure(null);
    try {
      if (isEdit && milestone) {
        await updateMilestone.mutateAsync({
          id: milestone.id,
          companyId,
          title: title.trim(),
          description: description.trim() || null,
          type,
          status,
          dueDate: dueDate || null,
          achievedAt: achievedAt || null,
          sharedWithClient,
        });
      } else {
        await createMilestone.mutateAsync({
          employeeId: empId,
          companyId,
          title: title.trim(),
          description: description.trim() || null,
          type,
          status,
          dueDate: dueDate || null,
          achievedAt: achievedAt || null,
          sharedWithClient,
        });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.performance.milestones.dialog.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('weldhr.performance.milestones.dialog.editTitle')
              : t('weldhr.performance.milestones.dialog.createTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.employee')}</Label>
              <EmployeePicker
                value={empId}
                valueLabel={empLabel}
                onChange={(id, label) => {
                  setEmpId(id);
                  setEmpLabel(label);
                }}
                disabled={isEdit || Boolean(lockedEmployeeId)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.client')}</Label>
              <CompanyPicker
                value={companyId}
                valueLabel={companyLabel}
                onChange={(id, label) => {
                  setCompanyId(id);
                  setCompanyLabel(label);
                }}
                allowClear
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="milestone-title">{t('weldhr.performance.milestones.dialog.titleLabel')}</Label>
            <Input
              id="milestone-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('weldhr.performance.milestones.dialog.titlePlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="milestone-description">{t('weldhr.performance.milestones.dialog.description')}</Label>
            <Textarea
              id="milestone-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('weldhr.performance.milestones.dialog.type')}</Label>
              <Select value={type} onValueChange={(v) => setType(v as HrMilestoneType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`weldhr.status.milestoneType.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.status')}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as HrMilestoneStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`weldhr.status.milestone.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="milestone-due">{t('weldhr.performance.milestones.dialog.dueDate')}</Label>
              <Input id="milestone-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="milestone-achieved">{t('weldhr.performance.milestones.dialog.achievedDate')}</Label>
              <Input
                id="milestone-achieved"
                type="date"
                value={achievedAt}
                onChange={(e) => setAchievedAt(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{t('weldhr.common.sharedWithClient')}</p>
              <p className="text-xs text-muted-foreground">{t('weldhr.common.sharedWithClientHint')}</p>
            </div>
            <Switch checked={sharedWithClient} onCheckedChange={setSharedWithClient} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || !empId || !title.trim()}>
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
