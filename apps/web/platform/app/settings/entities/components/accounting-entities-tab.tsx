/** Settings → Entities — the WeldBooks legal entities (the Accounting tab). */

import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { Building2 } from 'lucide-react';
import { useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import { localToday } from '@/lib/weldbooks/format';
import { DEFAULT_TERMINOLOGY } from '@/lib/weldbooks/jurisdiction';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { EmptyStateIllustration } from '@/components/entity-list';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useI18n } from '@/lib/i18n/provider';

interface EntityRow {
  id: string;
  name: string;
  legalName?: string | null;
  entityType?: string | null;
  jurisdictionCode: string;
  baseCurrency: string;
  locale: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  taxIdentifiers?: {
    vatNumber?: string;
    registrationNumber?: string;
  } | null;
  jurisdictionSettings?: {
    kor?: { enabled?: boolean; startDate?: string };
    [key: string]: unknown;
  } | null;
}

export function AccountingEntitiesTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const te = t.accounting.entities;

  const { data = [], isLoading, error } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const { data: jurisdictions = [] } = useAccountingJurisdictions();
  const canCreate = useCan('entities:create');
  const canUpdate = useCan('entities:update');
  const jurisdictionOf = (e: EntityRow) =>
    jurisdictions.find((j) => j.code.toUpperCase() === e.jurisdictionCode?.toUpperCase());
  const tt = t.accounting.terminology;
  // US legal forms have their own labels; the other jurisdictions keep the short code.
  const usTypeLabels = t.weldbooksUs.setup.entityTypes as Record<string, string>;
  const typeLabels = t.accounting.entityTypes as Record<string, string>;
  const entityTypeLabel = (type: string) => usTypeLabels[type] ?? typeLabels[type] ?? type.toUpperCase();

  const korMutation = useMutation({
    mutationFn: async ({ entity, enabled }: { entity: EntityRow; enabled: boolean }) => {
      const jurisdictionSettings = {
        ...entity.jurisdictionSettings,
        kor: enabled
          ? { enabled: true, startDate: localToday() }
          : { enabled: false },
      };
      await weldbooksApi.patch(`/accounting-entities/${entity.id}`, { jurisdictionSettings });
      return enabled;
    },
    onSuccess: (enabled) => {
      queryClient.invalidateQueries({ queryKey: ['accounting', 'entities'] });
      toast.success(enabled ? te.korToggleOn : te.korToggleOff);
    },
    onError: () => toast.error(te.korUpdateFailed),
  });

  const openEntity = (e: EntityRow) => navigate({ to: '/settings/entities/$id/edit', params: { id: e.id } });
  const openCreate = () => navigate({ to: '/settings/entities/add' });

  const columns: ColumnDef<EntityRow>[] = [
    {
      id: 'name',
      header: te.colName,
      width: 'flex-1',
      render: (e) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{e.name}</span>
            {e.isDefault ? <Badge variant="secondary">{te.badgeDefault}</Badge> : null}
            {e.isActive === false ? <Badge variant="outline">{te.badgeInactive}</Badge> : null}
          </div>
          {e.legalName ? (
            <div className="truncate text-xs text-muted-foreground">{e.legalName}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'jurisdiction',
      header: te.colJurisdiction,
      width: 'w-[150px]',
      render: (e) => (
        <div className="min-w-0">
          <div>
            {e.jurisdictionCode}
            <span className="ml-1 text-xs text-muted-foreground">· {e.baseCurrency}</span>
          </div>
          {e.entityType ? (
            <div className="truncate text-xs text-muted-foreground">{entityTypeLabel(e.entityType)}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'taxIds',
      header: te.colTaxIds,
      width: 'w-[170px]',
      render: (e) => {
        const terminology = jurisdictionOf(e)?.terminology ?? DEFAULT_TERMINOLOGY;
        const taxId = e.taxIdentifiers?.vatNumber;
        return (
          <div className="min-w-0 text-xs text-muted-foreground">
            {taxId ? <div className="truncate">{`${tt.taxId[terminology.taxId]}: ${taxId}`}</div> : null}
            {e.taxIdentifiers?.registrationNumber ? (
              <div className="truncate">{`${tt.registrationId[terminology.registrationId]}: ${e.taxIdentifiers.registrationNumber}`}</div>
            ) : null}
          </div>
        );
      },
    },
    // Only when some entity's jurisdiction has a small-business scheme (the Dutch KOR).
    ...(data.some((e) => jurisdictionOf(e)?.features.smallBusinessScheme)
      ? [
          {
            id: 'kor',
            header: te.colKor,
            width: 'w-[110px]',
            render: (e: EntityRow) =>
              jurisdictionOf(e)?.features.smallBusinessScheme ? (
                <div title={e.jurisdictionSettings?.kor?.enabled ? te.korEnabled : te.korDisabled}>
                  <Switch
                    aria-label={te.colKor}
                    onClick={(ev) => ev.stopPropagation()}
                    checked={e.jurisdictionSettings?.kor?.enabled ?? false}
                    disabled={!canUpdate || korMutation.isPending}
                    onCheckedChange={(enabled) => korMutation.mutate({ entity: e, enabled })}
                  />
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <PanelEntityList<EntityRow>
      items={data}
      isLoading={isLoading}
      error={error as Error | null}
      columns={columns}
      onRowClick={openEntity}
      onEdit={openEntity}
      searchFields={['name', 'legalName']}
      searchPlaceholder={te.colName}
      createButton={canCreate ? { label: te.newEntity2, onClick: openCreate } : undefined}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Building2 className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: te.noEntities2,
        description: te.newLegalEntityDesc,
        action: canCreate ? { label: te.newEntity2, onClick: openCreate } : undefined,
      }}
    />
  );
}
