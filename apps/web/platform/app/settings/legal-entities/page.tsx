/**
 * Settings → Workspace → Legal entities: the workspace's companies, shared by
 * WeldBooks and WeldHR. Docs: weldsuite-documentation/plans/legal-entities.md ("Platform UI").
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Lock, Plus, Scale } from 'lucide-react';
import type { LegalEntity } from '@weldsuite/app-api-client/schemas/legal-entities';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Badge } from '@weldsuite/ui/components/badge';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';
import { useI18n } from '@/lib/i18n/provider';
import { CreateLegalEntityDialog } from './create-dialog';
import { useLegalFormLabel } from './legal-forms';

export default function LegalEntitiesSettingsPage() {
  const { t } = useI18n();
  const tl = t.settings.legalEntities;
  const navigate = useNavigate();
  const canRead = useCan('legal_entities:read');
  const canCreate = useCan('legal_entities:create');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const legalFormLabel = useLegalFormLabel();
  const { data, isLoading, error, refetch } = useLegalEntities({ includeArchived, enabled: canRead });
  const appLabels = tl.apps as Record<string, string>;

  const columns: ListTableColumn<LegalEntity>[] = [
    {
      id: 'name',
      header: tl.columns.name,
      width: 'min-w-[200px] flex-1',
      cell: (entity) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{entity.name}</p>
            {entity.legalName && entity.legalName !== entity.name && (
              <p className="truncate text-xs text-muted-foreground">{entity.legalName}</p>
            )}
          </div>
          {entity.isDefault && <SoftBadge tone="success">{tl.badges.default}</SoftBadge>}
          {!entity.isActive && <SoftBadge tone="neutral">{tl.badges.archived}</SoftBadge>}
          {entity.accessRestricted && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label={tl.badges.restricted} />
              </TooltipTrigger>
              <TooltipContent>{tl.badges.restricted}</TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: 'legalForm',
      header: tl.columns.legalForm,
      width: 'w-[180px]',
      cell: (entity) => (
        <span className="truncate text-sm">{entity.entityType ? legalFormLabel(entity.entityType) : '-'}</span>
      ),
    },
    {
      id: 'country',
      header: tl.columns.country,
      width: 'w-[80px]',
      accessor: (entity) => entity.jurisdictionCode,
    },
    {
      id: 'currency',
      header: tl.columns.currency,
      width: 'w-[80px]',
      accessor: (entity) => entity.baseCurrency,
    },
    {
      id: 'usedBy',
      header: tl.columns.usedBy,
      width: 'w-[180px]',
      cell: (entity) => (
        <div className="flex flex-wrap gap-1">
          {entity.enabledApps.map((app) => (
            <Badge key={app} variant="outline">
              {appLabels[app] ?? app}
            </Badge>
          ))}
        </div>
      ),
    },
  ];

  let content;
  if (!canRead) {
    content = <EmptyState icon={Lock} title={tl.noAccess} />;
  } else if (isLoading) {
    content = <PageLoader fullScreen={false} className="min-h-[200px] pb-0" />;
  } else if (error) {
    content = <ErrorState message={tl.loadFailed} onRetry={() => refetch()} retryLabel={tl.retry} />;
  } else {
    content = (
      <ListTable
        columns={columns}
        data={data ?? []}
        rowKey={(entity) => entity.id}
        rowLabel={(entity) => entity.name}
        onRowClick={(entity) => navigate({ to: '/settings/legal-entities/$id', params: { id: entity.id } })}
        emptyState={{
          icon: <Scale className="h-8 w-8" />,
          title: includeArchived ? tl.empty.archivedTitle : tl.empty.title,
          description: includeArchived ? tl.empty.archivedDescription : tl.empty.description,
          action: canCreate ? { label: tl.add, onClick: () => setCreating(true) } : undefined,
        }}
      />
    );
  }

  return (
    <DashboardPage
      title={tl.title}
      description={tl.description}
      className="max-w-5xl"
      actions={
        canRead ? (
          <>
            <div className="flex items-center gap-2">
              <Switch id="legal-entities-archived" checked={includeArchived} onCheckedChange={setIncludeArchived} />
              <Label htmlFor="legal-entities-archived" className="text-sm font-normal">
                {tl.showArchived}
              </Label>
            </div>
            {canCreate && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {tl.add}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {content}
      <CreateLegalEntityDialog
        open={creating}
        onOpenChange={setCreating}
        isFirst={(data ?? []).length === 0 && !includeArchived}
        onCreated={(entity) => navigate({ to: '/settings/legal-entities/$id', params: { id: entity.id } })}
      />
    </DashboardPage>
  );
}
