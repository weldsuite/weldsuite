/**
 * Log / edit a coaching session. Shared by the coaching list page and the
 * employee coaching tab — pass `employeeId` to prefill and lock the employee.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  HrCoachingActionItem,
  HrCoachingCategory,
  HrCoachingLog,
  HrCoachingStatus,
  HrVisibility,
} from '@weldsuite/app-api-client/domains/weldhr';
import {
  useCreateHrCoaching,
  useUpdateHrCoaching,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  ErrorBanner,
  errorMessage,
} from '../../components/shared';

const CATEGORIES: HrCoachingCategory[] = [
  'performance',
  'quality',
  'behavior',
  'attendance',
  'development',
  'recognition',
];
const STATUSES: HrCoachingStatus[] = ['open', 'acknowledged', 'closed'];
const VISIBILITIES: HrVisibility[] = ['internal', 'employee', 'client'];

export function CoachingDialog({
  log,
  employeeId,
  employeeLabel,
  onClose,
}: {
  log?: HrCoachingLog | null;
  employeeId?: string;
  employeeLabel?: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const isEdit = Boolean(log);
  const createCoaching = useCreateHrCoaching();
  const updateCoaching = useUpdateHrCoaching();

  const [empId, setEmpId] = useState<string | null>(log?.employeeId ?? employeeId ?? null);
  const [empLabel, setEmpLabel] = useState<string | null>(log?.employeeName ?? employeeLabel ?? null);
  const [companyId, setCompanyId] = useState<string | null>(log?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(log?.companyName ?? null);
  const [sessionDate, setSessionDate] = useState(log?.sessionDate ?? '');
  const [category, setCategory] = useState<HrCoachingCategory>(log?.category ?? 'performance');
  const [topic, setTopic] = useState(log?.topic ?? '');
  const [notes, setNotes] = useState(log?.notes ?? '');
  const [actionItems, setActionItems] = useState<HrCoachingActionItem[]>(log?.actionItems ?? []);
  const [followUpDate, setFollowUpDate] = useState(log?.followUpDate ?? '');
  const [visibility, setVisibility] = useState<HrVisibility>(log?.visibility ?? 'internal');
  const [status, setStatus] = useState<HrCoachingStatus>(log?.status ?? 'open');
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createCoaching.isPending || updateCoaching.isPending;

  function addActionItem() {
    setActionItems((items) => [...items, { id: crypto.randomUUID(), text: '', done: false }]);
  }
  function updateActionItem(id: string, patch: Partial<HrCoachingActionItem>) {
    setActionItems((items) => items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }
  function removeActionItem(id: string) {
    setActionItems((items) => items.filter((i) => i.id !== id));
  }

  async function submit() {
    if (!empId || !sessionDate || !topic.trim()) return;
    setFailure(null);
    const cleanActionItems = actionItems
      .map((i) => ({ ...i, text: i.text.trim() }))
      .filter((i) => i.text.length > 0);
    try {
      if (isEdit && log) {
        await updateCoaching.mutateAsync({
          id: log.id,
          companyId,
          sessionDate,
          category,
          topic: topic.trim(),
          notes: notes.trim() || null,
          actionItems: cleanActionItems,
          followUpDate: followUpDate || null,
          status,
          visibility,
        });
      } else {
        await createCoaching.mutateAsync({
          employeeId: empId,
          companyId,
          sessionDate,
          category,
          topic: topic.trim(),
          notes: notes.trim() || null,
          actionItems: cleanActionItems,
          followUpDate: followUpDate || null,
          status,
          visibility,
        });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.coaching.dialog.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('weldhr.coaching.dialog.editTitle') : t('weldhr.coaching.dialog.createTitle')}
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
                disabled={isEdit || Boolean(employeeId)}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="coaching-session-date">{t('weldhr.coaching.dialog.sessionDate')}</Label>
              <Input
                id="coaching-session-date"
                type="date"
                value={sessionDate}
                onChange={(e) => setSessionDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.coaching.dialog.category')}</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as HrCoachingCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`weldhr.status.coachingCategory.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="coaching-topic">{t('weldhr.coaching.dialog.topic')}</Label>
            <Input
              id="coaching-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('weldhr.coaching.dialog.topicPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="coaching-notes">{t('weldhr.common.notes')}</Label>
            <Textarea
              id="coaching-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('weldhr.coaching.dialog.notesPlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('weldhr.coaching.dialog.actionItems')}</Label>
              <Button type="button" variant="outline" size="sm" onClick={addActionItem}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {t('weldhr.coaching.dialog.addActionItem')}
              </Button>
            </div>
            {actionItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('weldhr.coaching.dialog.noActionItems')}</p>
            ) : (
              <div className="space-y-2">
                {actionItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={item.done}
                      onCheckedChange={(checked) => updateActionItem(item.id, { done: checked === true })}
                    />
                    <Input
                      value={item.text}
                      onChange={(e) => updateActionItem(item.id, { text: e.target.value })}
                      placeholder={t('weldhr.coaching.dialog.actionItemPlaceholder')}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeActionItem(item.id)}
                      aria-label={t('weldhr.common.remove')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="coaching-follow-up">{t('weldhr.coaching.dialog.followUpDate')}</Label>
              <Input
                id="coaching-follow-up"
                type="date"
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.status')}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as HrCoachingStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`weldhr.status.coaching.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.coaching.dialog.visibility')}</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as HrVisibility)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITIES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`weldhr.status.visibility.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`weldhr.coaching.dialog.visibilityHint.${visibility}`)}
            </p>
          </div>

          {log?.employeeComment && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('weldhr.coaching.acknowledgement.title')}
              </p>
              <p className="mt-1 text-sm">{log.employeeComment}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending || !empId || !sessionDate || !topic.trim()}
          >
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
