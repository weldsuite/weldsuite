/** Settings → Entities — the WeldBooks legal entities (the Accounting tab). */

import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Switch } from '@weldsuite/ui/components/switch';
import { Building2 } from 'lucide-react';
import { useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import { localToday } from '@/lib/weldbooks/format';
import { DEFAULT_TERMINOLOGY } from '@/lib/weldbooks/jurisdiction';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { EmptyStateIllustration } from '@/components/entity-list';
import { RowChip, RowText, RowTitle } from '@/components/accounting/weldbooks-row-cells';
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
      width: 'min-w-[160px] flex-1',
      // The legal name sits under the title: a column of its own does not fit the settings width.
      render: (e) => (
        <div className="min-w-0">
          <RowTitle
            chips={
              <>
                {e.isDefault ? <RowChip tone="indigo">{te.badgeDefault}</RowChip> : null}
                {e.isActive === false ? <RowChip tone="gray">{te.badgeInactive}</RowChip> : null}
              </>
            }
          >
            {e.name}
          </RowTitle>
          {e.legalName ? <RowText className="text-xs">{e.legalName}</RowText> : null}
        </div>
      ),
    },
    {
      id: 'jurisdiction',
      header: te.colJurisdiction,
      width: 'w-[150px]',
      render: (e) => (
        <div className="min-w-0">
          <RowText>{`${e.jurisdictionCode} · ${e.baseCurrency}`}</RowText>
          {e.entityType ? <RowText className="text-xs">{entityTypeLabel(e.entityType)}</RowText> : null}
        </div>
      ),
    },
    {
      id: 'taxIds',
      header: te.colTaxIds,
      width: 'w-[170px]',
      render: (e) => {
        const terminology = jurisdictionOf(e)?.terminology ?? DEFAULT_TERMINOLOGY;
        const parts = [
          e.taxIdentifiers?.vatNumber ? `${tt.taxId[terminology.taxId]}: ${e.taxIdentifiers.vatNumber}` : null,
          e.taxIdentifiers?.registrationNumber
            ? `${tt.registrationId[terminology.registrationId]}: ${e.taxIdentifiers.registrationNumber}`
            : null,
        ].filter((part): part is string => part !== null);
        const text = parts.join(' · ');
        return (
          <RowText className="text-xs">
            {text ? <span title={text}>{text}</span> : null}
          </RowText>
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
        description: te.emptyDescription,
        action: canCreate ? { label: te.newEntity2, onClick: openCreate } : undefined,
      }}
    />
  );
}
