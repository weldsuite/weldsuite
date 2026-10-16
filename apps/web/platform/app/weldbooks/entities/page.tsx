import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Switch } from '@weldsuite/ui/components/switch';
import { Building2, EllipsisVertical, Pencil } from 'lucide-react';
import { useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import { localToday } from '@/lib/weldbooks/format';
import { DEFAULT_TERMINOLOGY } from '@/lib/weldbooks/jurisdiction';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowChip, RowText, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
} from '@/components/entity-list';
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

export default function EntitiesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const te = t.accounting.entities;

  const { data = [], isLoading } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const { data: jurisdictions = [] } = useAccountingJurisdictions();
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

  const columns: ColumnDef<EntityRow>[] = [
    {
      id: 'name',
      header: te.colName,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (e) => (
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
      ),
    },
    {
      id: 'legalName',
      header: te.legalName,
      width: 'w-[200px]',
      render: (e) => <RowText>{e.legalName}</RowText>,
    },
    {
      id: 'jurisdiction',
      header: te.colJurisdiction,
      width: 'w-[160px]',
      render: (e) => (
        <RowText>{e.entityType ? `${e.jurisdictionCode} · ${entityTypeLabel(e.entityType)}` : e.jurisdictionCode}</RowText>
      ),
    },
    {
      id: 'currency',
      header: te.colCurrency,
      width: 'w-[80px]',
      render: (e) => <RowText>{e.baseCurrency}</RowText>,
    },
    {
      id: 'taxIds',
      header: te.colTaxIds,
      width: 'w-[260px]',
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
    {
      id: 'kor',
      header: te.colKor,
      width: 'w-[120px]',
      render: (e) =>
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
  ];

  return (
    <WeldbooksEntityList<EntityRow>
      items={data}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(e) => navigate({ to: '/weldbooks/entities/$id/edit', params: { id: e.id } })}
      getRowLabel={(e) => e.name}
      renderRowMenu={(e) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={te.editEntity}
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => navigate({ to: '/weldbooks/entities/$id/edit', params: { id: e.id } })}>
              <Pencil className="h-3.5 w-3.5 mr-0.5" />
              {te.editEntity}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      searchFields={['name', 'legalName']}
      searchPlaceholder={te.colName}
      createButton={{
        label: te.newEntity2,
        onClick: () => navigate({ to: '/weldbooks/entities/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Building2 className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: te.noEntities2,
        description: te.emptyDescription,
        action: {
          label: te.newEntity2,
          onClick: () => navigate({ to: '/weldbooks/entities/add' }),
        },
      }}
    />
  );
}
