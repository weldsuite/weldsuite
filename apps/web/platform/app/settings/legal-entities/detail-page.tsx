/**
 * Settings → Legal entities → one entity: General, Registrations, Bank
 * accounts, Used by and (with `legal_entities:manage`) Access.
 */

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Lock, Star, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DetailHeader, DetailPage, TabBody } from '@weldsuite/ui/components/page-layout';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorBanner, ErrorState } from '@weldsuite/ui/components/error-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { RegistrationList } from '@/components/legal-entity/registration-list';
import {
  useArchiveLegalEntity,
  useDeleteLegalEntity,
  useLegalEntity,
  useMakeDefaultLegalEntity,
} from '@/hooks/queries/use-legal-entities-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AccessTab } from './access-tab';
import { BankAccountsTab } from './bank-accounts-tab';
import { GeneralTab } from './general-tab';
import { UsageTab } from './usage-tab';

const TAB_IDS = ['general', 'registrations', 'bank-accounts', 'used-by', 'access'] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | undefined): value is TabId {
  return Boolean(value) && (TAB_IDS as readonly string[]).includes(value as string);
}

type PendingConfirm = 'archive' | 'delete' | null;

export default function LegalEntityDetailPage() {
  const { t } = useI18n();
  const tl = t.settings.legalEntities;
  const td = tl.detail;
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }) as { id?: string };
  const search: { tab?: string } = useSearch({ strict: false });

  const canRead = useCan('legal_entities:read');
  const canUpdate = useCan('legal_entities:update');
  const canDelete = useCan('legal_entities:delete');
  const canManage = useCan('legal_entities:manage');

  const { data: entity, isLoading, error, refetch } = useLegalEntity(canRead ? id : null);
  const makeDefault = useMakeDefaultLegalEntity();
  const archive = useArchiveLegalEntity();
  const remove = useDeleteLegalEntity();
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  // Refusals (409: the default, or an app holds data) show here, above the tabs.
  const [actionError, setActionError] = useState<string | null>(null);

  const tabs = useMemo<PageTab[]>(
    () => [
      { id: 'general', label: td.tabs.general },
      { id: 'registrations', label: td.tabs.registrations },
      { id: 'bank-accounts', label: td.tabs.bankAccounts },
      { id: 'used-by', label: td.tabs.usedBy },
      ...(canManage ? [{ id: 'access', label: td.tabs.access }] : []),
    ],
    [td, canManage],
  );
  const requested = isTabId(search.tab) ? search.tab : undefined;
  const activeTab = tabs.find((tab) => tab.id === requested)?.id ?? 'general';

  function goBack() {
    navigate({ to: '/settings/legal-entities' });
  }

  async function run(action: () => Promise<unknown>, success: string, afterSuccess?: () => void) {
    setActionError(null);
    try {
      await action();
      toast.success(success);
      afterSuccess?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : td.actionFailed);
    }
  }

  if (!canRead) return <ErrorState message={tl.noAccess} />;
  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error || !entity) {
    return <ErrorState message={td.notFound} onRetry={() => refetch()} retryLabel={tl.retry} />;
  }

  const archived = !entity.isActive;

  return (
    <DetailPage>
      <DetailHeader
        onBack={goBack}
        backLabel={td.back}
        title={entity.name}
        subtitle={entity.legalName && entity.legalName !== entity.name ? entity.legalName : undefined}
        badges={
          <>
            {entity.isDefault && <SoftBadge tone="success">{tl.badges.default}</SoftBadge>}
            {archived && <SoftBadge tone="neutral">{tl.badges.archived}</SoftBadge>}
            {entity.accessRestricted && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Lock className="h-4 w-4 text-muted-foreground" aria-label={tl.badges.restricted} />
                </TooltipTrigger>
                <TooltipContent>{tl.badges.restricted}</TooltipContent>
              </Tooltip>
            )}
          </>
        }
        actions={
          <>
            {canUpdate && !entity.isDefault && !archived && (
              <Button
                variant="outline"
                size="sm"
                disabled={makeDefault.isPending}
                onClick={() => run(() => makeDefault.mutateAsync(entity.id), td.makeDefaultSuccess)}
              >
                <Star className="mr-2 h-4 w-4" />
                {td.makeDefault}
              </Button>
            )}
            {canDelete &&
              (archived ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={archive.isPending}
                  onClick={() =>
                    run(() => archive.mutateAsync({ id: entity.id, archived: false }), td.unarchiveSuccess)
                  }
                >
                  <ArchiveRestore className="mr-2 h-4 w-4" />
                  {td.unarchive}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setConfirm('archive')}>
                  <Archive className="mr-2 h-4 w-4" />
                  {td.archive}
                </Button>
              ))}
            {canDelete && (
              <Button variant="outline" size="sm" onClick={() => setConfirm('delete')}>
                <Trash2 className="mr-2 h-4 w-4" />
                {td.delete}
              </Button>
            )}
          </>
        }
      />

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />

      <PageTabs
        tabs={tabs}
        activeTab={activeTab}
        overflow="dropdown"
        onTabChange={(tab) => navigate({ to: '/settings/legal-entities/$id', params: { id: entity.id }, search: { tab } })}
      />

      <TabBody className="p-0">
        {activeTab === 'general' && <GeneralTab entity={entity} canEdit={canUpdate} />}
        {activeTab === 'registrations' && (
          <div className="max-w-3xl">
            <RegistrationList entityId={entity.id} jurisdictionCode={entity.jurisdictionCode} canEdit={canUpdate} />
          </div>
        )}
        {activeTab === 'bank-accounts' && (
          <div className="max-w-3xl">
            <BankAccountsTab entity={entity} canEdit={canUpdate} />
          </div>
        )}
        {activeTab === 'used-by' && <UsageTab entityId={entity.id} />}
        {activeTab === 'access' && canManage && <AccessTab entity={entity} />}
      </TabBody>

      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={td.archiveTitle}
        description={td.archiveDescription}
        confirmLabel={td.archive}
        onConfirm={async () => {
          await run(() => archive.mutateAsync({ id: entity.id, archived: true }), td.archiveSuccess);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={td.deleteTitle}
        description={td.deleteDescription}
        confirmLabel={td.delete}
        variant="destructive"
        onConfirm={async () => {
          await run(() => remove.mutateAsync(entity.id), td.deleteSuccess, goBack);
          setConfirm(null);
        }}
      />
    </DetailPage>
  );
}
