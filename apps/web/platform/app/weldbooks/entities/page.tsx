import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { Building2 } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
} from '@/components/entity-list';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

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
  const st = useTranslations();
  const te = t.accounting.entities;

  const { data = [], isLoading } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const korMutation = useMutation({
    mutationFn: async ({ entity, enabled }: { entity: EntityRow; enabled: boolean }) => {
      const jurisdictionSettings = {
        ...(entity.jurisdictionSettings ?? {}),
        kor: enabled
          ? { enabled: true, startDate: new Date().toISOString().slice(0, 10) }
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
      width: 'flex-1',
      render: (e) => (
        <div>
          <div className="font-medium">{e.name}</div>
          {e.legalName ? (
            <div className="text-xs text-muted-foreground">{e.legalName}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'jurisdiction',
      header: te.colJurisdiction,
      width: 'w-[140px]',
      render: (e) => (
        <span>
          {e.jurisdictionCode}
          {e.entityType ? (
            <span className="text-xs text-muted-foreground ml-1">
              · {e.entityType.toUpperCase()}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'currency',
      header: te.colCurrency,
      width: 'w-[100px]',
      render: (e) => <span className="text-muted-foreground">{e.baseCurrency}</span>,
    },
    {
      id: 'taxIds',
      header: te.colTaxIds,
      width: 'w-[200px]',
      render: (e) => (
        <div className="text-xs text-muted-foreground">
          {e.taxIdentifiers?.vatNumber ? <div>{st('sweep.weldbooks.entitiesList.vatPrefix', { value: e.taxIdentifiers.vatNumber })}</div> : null}
          {e.taxIdentifiers?.registrationNumber ? (
            <div>{st('sweep.weldbooks.entitiesList.regPrefix', { value: e.taxIdentifiers.registrationNumber })}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'kor',
      header: te.colKor,
      width: 'w-[80px]',
      render: (e) =>
        e.jurisdictionCode === 'NL' ? (
          <div
            title={e.jurisdictionSettings?.kor?.enabled ? te.korEnabled : te.korDisabled}
            onClick={(ev) => ev.stopPropagation()}
          >
            <Switch
              checked={e.jurisdictionSettings?.kor?.enabled ?? false}
              disabled={korMutation.isPending}
              onCheckedChange={(enabled) => korMutation.mutate({ entity: e, enabled })}
            />
          </div>
        ) : null,
    },
    {
      id: 'badges',
      header: '',
      width: 'w-[120px]',
      render: (e) => (
        <div className="flex justify-end gap-1">
          {e.isDefault ? <Badge variant="secondary">{te.badgeDefault}</Badge> : null}
          {e.isActive === false ? (
            <Badge variant="outline">{te.badgeInactive}</Badge>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <WeldbooksEntityList<EntityRow>
      items={data}
      isLoading={isLoading}
      columns={columns}
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
        description: te.newLegalEntityDesc,
        action: {
          label: te.newEntity2,
          onClick: () => navigate({ to: '/weldbooks/entities/add' }),
        },
      }}
    />
  );
}
