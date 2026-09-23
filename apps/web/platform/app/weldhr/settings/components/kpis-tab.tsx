/** WeldHR settings — KPI definitions tab. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrKpiDefinition, HrKpiDirection, HrKpiUnit } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrKpis,
  useCreateHrKpi,
  useUpdateHrKpi,
  useDeleteHrKpi,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CompanyPicker, EmptyState, ErrorBanner, InlineSpinner, errorMessage, formatKpiValue } from '../../components/shared';

const UNITS: HrKpiUnit[] = ['number', 'percent', 'seconds', 'minutes', 'currency'];
const DIRECTIONS: HrKpiDirection[] = ['higher_better', 'lower_better'];

interface FormState {
  id: string | null;
  name: string;
  description: string;
  unit: HrKpiUnit;
  direction: HrKpiDirection;
  target: string;
  companyId: string | null;
  companyName: string | null;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  description: '',
  unit: 'number',
  direction: 'higher_better',
  target: '',
  companyId: null,
  companyName: null,
  isActive: true,
};

export function KpisTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const [includeInactive, setIncludeInactive] = useState(false);
  const { data: kpis, isLoading, error } = useHrKpis({ includeInactive });
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrKpiDefinition | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('weldhr.settings.kpis.subtitle')}</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="kpi-include-inactive" checked={includeInactive} onCheckedChange={setIncludeInactive} />
            <Label htmlFor="kpi-include-inactive" className="text-sm font-normal">
              {t('weldhr.settings.kpis.includeInactive')}
            </Label>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.settings.kpis.add')}
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !kpis || kpis.length === 0 ? (
        <EmptyState title={t('weldhr.settings.kpis.emptyTitle')} description={t('weldhr.settings.kpis.emptyDescription')} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.settings.kpis.name')}</TableHead>
                <TableHead>{t('weldhr.settings.kpis.unit')}</TableHead>
                <TableHead>{t('weldhr.settings.kpis.direction')}</TableHead>
                <TableHead className="text-right">{t('weldhr.settings.kpis.target')}</TableHead>
                <TableHead>{t('weldhr.settings.kpis.clientSpecific')}</TableHead>
                <TableHead>{t('weldhr.common.status')}</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpis.map((kpi) => (
                <TableRow key={kpi.id}>
                  <TableCell className="font-medium">{kpi.name}</TableCell>
                  <TableCell>{t(`weldhr.status.kpiUnit.${kpi.unit}`)}</TableCell>
                  <TableCell>{t(`weldhr.status.kpiDirection.${kpi.direction}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatKpiValue(kpi.target, kpi.unit)}</TableCell>
                  <TableCell className="text-muted-foreground">{kpi.companyName ?? t('weldhr.settings.kpis.allClients')}</TableCell>
                  <TableCell>
                    <Badge variant={kpi.isActive ? 'default' : 'secondary'}>
                      {kpi.isActive ? t('weldhr.settings.evaluationForms.active') : t('weldhr.settings.evaluationForms.inactive')}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setForm({
                              id: kpi.id,
                              name: kpi.name,
                              description: kpi.description ?? '',
                              unit: kpi.unit,
                              direction: kpi.direction,
                              target: kpi.target === null ? '' : String(kpi.target),
                              companyId: kpi.companyId,
                              companyName: kpi.companyName,
                              isActive: kpi.isActive,
                            })
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => setDeleteTarget(kpi)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {form && <KpiDialog form={form} onClose={() => setForm(null)} />}

      {deleteTarget && <DeleteKpiDialog kpi={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

function KpiDialog({ form, onClose }: { form: FormState; onClose: () => void }) {
  const t = useTranslations();
  const createKpi = useCreateHrKpi();
  const updateKpi = useUpdateHrKpi();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createKpi.isPending || updateKpi.isPending;

  async function submit() {
    if (!state.name.trim()) return;
    setFailure(null);
    const target = state.target.trim();
    const payload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      unit: state.unit,
      direction: state.direction,
      target: target === '' ? null : Number(target),
      companyId: state.companyId,
      isActive: state.isActive,
    };
    try {
      if (state.id) {
        await updateKpi.mutateAsync({ id: state.id, ...payload });
      } else {
        await createKpi.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t('weldhr.settings.kpis.editTitle') : t('weldhr.settings.kpis.addTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="kpi-name">{t('weldhr.settings.kpis.name')}</Label>
            <Input id="kpi-name" value={state.name} onChange={(e) => setState({ ...state, name: e.target.value })} autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kpi-description">{t('weldhr.settings.kpis.description')}</Label>
            <Textarea
              id="kpi-description"
              value={state.description}
              onChange={(e) => setState({ ...state, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('weldhr.settings.kpis.unit')}</Label>
              <Select value={state.unit} onValueChange={(v) => setState({ ...state, unit: v as HrKpiUnit })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {t(`weldhr.status.kpiUnit.${unit}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.settings.kpis.direction')}</Label>
              <Select value={state.direction} onValueChange={(v) => setState({ ...state, direction: v as HrKpiDirection })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIRECTIONS.map((direction) => (
                    <SelectItem key={direction} value={direction}>
                      {t(`weldhr.status.kpiDirection.${direction}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kpi-target">{t('weldhr.settings.kpis.target')}</Label>
            <Input
              id="kpi-target"
              type="number"
              value={state.target}
              placeholder={t('weldhr.settings.kpis.targetPlaceholder')}
              onChange={(e) => setState({ ...state, target: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.settings.kpis.clientSpecific')}</Label>
            <CompanyPicker
              value={state.companyId}
              valueLabel={state.companyName}
              onChange={(id, label) => setState({ ...state, companyId: id, companyName: label })}
              placeholder={t('weldhr.settings.kpis.allClients')}
              allowClear
            />
            <p className="text-xs text-muted-foreground">{t('weldhr.settings.kpis.clientSpecificHint')}</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="kpi-active">{t('weldhr.settings.evaluationForms.active')}</Label>
            <Switch id="kpi-active" checked={state.isActive} onCheckedChange={(checked) => setState({ ...state, isActive: checked })} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || !state.name.trim()}>
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteKpiDialog({ kpi, onClose }: { kpi: HrKpiDefinition; onClose: () => void }) {
  const t = useTranslations();
  const deleteKpi = useDeleteHrKpi();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.kpis.deleteTitle')}
        description={t('weldhr.settings.kpis.deleteDescription', { name: kpi.name })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            const result = await deleteKpi.mutateAsync(kpi.id);
            if (result.data.archived) {
              toast.info(t('weldhr.settings.kpis.archivedInstead', { name: kpi.name }));
            }
            onClose();
          } catch (err) {
            setFailure(errorMessage(err, t('weldhr.common.deleteFailed')));
          }
        }}
      />
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
    </>
  );
}
