/** WeldHR settings — KPI definitions tab. */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Target } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Loader2 } from 'lucide-react';
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
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { CompanyPicker, ErrorBanner, errorMessage, formatKpiValue } from '../../components/shared';
import { emptyIcon } from '../../components/page-kit';

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
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    const all = kpis ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter((kpi) => kpi.name.toLowerCase().includes(q));
  }, [kpis, search]);

  const groups: GroupConfig<HrKpiDefinition>[] = [
    { id: 'workspace', label: t('weldhr.settings.kpis.groupWorkspace'), sortOrder: 1, filter: (i) => !i.companyId },
    { id: 'client', label: t('weldhr.settings.kpis.groupClient'), sortOrder: 2, filter: (i) => Boolean(i.companyId) },
  ];

  const columns: ColumnDef<HrKpiDefinition>[] = [
    {
      id: 'name',
      header: t('weldhr.settings.kpis.name'),
      width: 'flex-1',
      render: (kpi) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{kpi.name}</p>
            {!kpi.isActive && <Badge variant="secondary">{t('weldhr.settings.evaluationForms.inactive')}</Badge>}
          </div>
          {kpi.companyName && <p className="truncate text-xs text-muted-foreground">{kpi.companyName}</p>}
        </div>
      ),
    },
    {
      id: 'unit',
      header: t('weldhr.settings.kpis.unit'),
      width: 'w-[120px]',
      render: (kpi) => <span className="text-muted-foreground">{t(`weldhr.status.kpiUnit.${kpi.unit}`)}</span>,
    },
    {
      id: 'direction',
      header: t('weldhr.settings.kpis.direction'),
      width: 'w-[150px]',
      render: (kpi) => <span className="text-muted-foreground">{t(`weldhr.status.kpiDirection.${kpi.direction}`)}</span>,
    },
    {
      id: 'target',
      header: t('weldhr.settings.kpis.target'),
      width: 'w-[110px]',
      render: (kpi) => <span className="tabular-nums">{formatKpiValue(kpi.target, kpi.unit)}</span>,
    },
  ];

  return (
    <>
      <PanelEntityList<HrKpiDefinition>
        items={items}
        isLoading={isLoading}
        error={error as Error | null}
        columns={columns}
        groups={groups}
        onEdit={
          canManage
            ? (kpi) =>
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
            : undefined
        }
        onDelete={canManage ? setDeleteTarget : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.settings.kpis.name')}
        actionButtons={
          <label className="flex h-8 items-center gap-2 px-1 text-sm">
            <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
            <span className="hidden text-muted-foreground md:inline">{t('weldhr.settings.kpis.includeInactive')}</span>
          </label>
        }
        createButton={canManage ? { label: t('weldhr.settings.kpis.add'), onClick: () => setForm({ ...EMPTY_FORM }) } : undefined}
        emptyState={{
          icon: emptyIcon(Target),
          title: t('weldhr.settings.kpis.emptyTitle'),
          description: t('weldhr.settings.kpis.emptyDescription'),
          action: canManage ? { label: t('weldhr.settings.kpis.add'), onClick: () => setForm({ ...EMPTY_FORM }) } : undefined,
        }}
      />

      {form && <KpiDialog form={form} onClose={() => setForm(null)} />}

      {deleteTarget && <DeleteKpiDialog kpi={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </>
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
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.common.save')}
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
