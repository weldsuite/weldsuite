/**
 * WeldPass passwords — the team password manager.
 *
 * Vaults on the left, items on the right. The vault filter and the opened item
 * live in the URL (`?vault=…&item=…`) so a reload keeps them and a link can
 * point at one login.
 *
 * Lists carry no secrets. A password is fetched only when the user presses
 * Reveal, Copy or Edit (see item-detail-dialog.tsx); every such fetch is
 * recorded on the vault's trail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { HeartPulse, Lock, Plus, Search, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  WeldPassItem,
  WeldPassRevealedItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { PageLoader } from '@/components/page-loader';
import {
  useWeldPassItems,
  useWeldPassVaults,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { EmptyState, ErrorBanner, InlineSpinner, errorMessage } from '../components/shared';
import { CreateVaultDialog } from './components/create-vault-dialog';
import { ImportDialog } from './components/import-dialog';
import { ItemDetailDialog } from './components/item-detail-dialog';
import { ItemFormDialog } from './components/item-form-dialog';
import { ItemHistoryDialog } from './components/item-history-dialog';
import { ItemTable } from './components/item-table';
import { MoveItemDialog } from './components/move-item-dialog';
import { VaultSettingsDialog } from './components/vault-settings-dialog';
import { VaultSidebar } from './components/vault-sidebar';
import {
  canAdministerVault,
  canEditVault,
  countByVault,
  defaultCreateVaultId,
  filterItems,
  isNonMemberView,
  moveTargets,
  sortVaults,
  writableVaults,
  type ItemTypeFilter,
} from './lib/items';
import { usePasswordsT } from './lib/use-passwords-t';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; item: WeldPassRevealedItem }
  | { kind: 'move'; item: WeldPassItem }
  | { kind: 'history'; item: WeldPassItem }
  | { kind: 'import' }
  | { kind: 'newVault' }
  | { kind: 'settings'; vaultId: string }
  | null;

const TYPE_FILTERS: ItemTypeFilter[] = ['all', 'login', 'note', 'card'];

export default function WeldPassPasswordsPage() {
  const tp = usePasswordsT();
  const { can, isLoading } = usePermissions();

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!can('passwords:use')) {
    return (
      <AccessDeniedEmptyState
        description={tp('accessDenied')}
        permission="passwords:use"
        pageLabel="WeldPass passwords"
      />
    );
  }
  return <PasswordsWorkspace />;
}

function PasswordsWorkspace() {
  const tp = usePasswordsT();
  const { can } = usePermissions();
  const { user } = useUser();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { vault?: string; item?: string };

  const vaultsQuery = useWeldPassVaults();
  const itemsQuery = useWeldPassItems();
  const [typeFilter, setTypeFilter] = useState<ItemTypeFilter>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  const canManageAll = can('passwords:manage');
  const canCreateVault = can('passwords:create') || canManageAll;

  const vaults = useMemo(() => sortVaults(vaultsQuery.data ?? []), [vaultsQuery.data]);
  const vaultsById = useMemo(() => new Map(vaults.map((vault) => [vault.id, vault])), [vaults]);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const counts = useMemo(() => countByVault(items), [items]);

  const selectedVault = search.vault ? (vaultsById.get(search.vault) ?? null) : null;
  const openItem = search.item ? items.find((item) => item.id === search.item) : undefined;
  const openItemVault = openItem ? vaultsById.get(openItem.vaultId) : undefined;

  const visibleItems = useMemo(
    () => filterItems(items, { vaultId: selectedVault?.id, type: typeFilter, query }),
    [items, selectedVault?.id, typeFilter, query],
  );

  // A personal vault is shown by a translated label, never its stored name.
  const vaultLabel = (vault: WeldPassVault) =>
    vault.kind === 'personal' ? tp('vaults.personal') : vault.name;

  const setSearch = useCallback(
    (patch: { vault?: string; item?: string }, options: { replace?: boolean } = {}) => {
      void navigate({
        to: '/weldpass/passwords',
        search: (previous: { vault?: string; item?: string }) => ({ ...previous, ...patch }),
        replace: options.replace ?? true,
      });
    },
    [navigate],
  );

  // A link to an item that no longer exists (moved, deleted, no access) should
  // not leave a dead `?item=` behind.
  useEffect(() => {
    if (search.item && itemsQuery.isSuccess && !openItem) {
      setSearch({ item: undefined });
    }
  }, [search.item, itemsQuery.isSuccess, openItem, setSearch]);

  const writable = writableVaults(vaults);
  const canAdd = selectedVault ? canEditVault(selectedVault) : writable.length > 0;
  const createVaultId = defaultCreateVaultId(vaults, selectedVault?.id);
  const settingsVault = dialog?.kind === 'settings' ? vaultsById.get(dialog.vaultId) : undefined;

  function closeDialog() {
    setDialog(null);
  }

  const loading = vaultsQuery.isLoading || itemsQuery.isLoading;
  const loadError = vaultsQuery.error ?? itemsQuery.error;

  let body: React.ReactNode;
  if (loading) {
    body = <InlineSpinner />;
  } else if (loadError) {
    body = (
      <div className="space-y-3">
        <ErrorBanner error={errorMessage(loadError, tp('loadFailed'))} />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void vaultsQuery.refetch();
            void itemsQuery.refetch();
          }}
        >
          {tp('retry')}
        </Button>
      </div>
    );
  } else if (isNonMemberView(selectedVault) && selectedVault) {
    body = (
      <EmptyState
        title={tp('vaults.notMemberTitle')}
        description={tp('vaults.notMemberDescription')}
        action={
          canAdministerVault(selectedVault, canManageAll) ? (
            <Button onClick={() => setDialog({ kind: 'settings', vaultId: selectedVault.id })}>
              <Lock className="mr-1.5 h-4 w-4" />
              {tp('vaults.manageMembers')}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (visibleItems.length === 0) {
    const filtering = query.trim() !== '' || typeFilter !== 'all';
    body = filtering ? (
      <EmptyState
        title={tp('empty.noResultsTitle')}
        description={tp('empty.noResultsDescription')}
        action={
          <Button
            variant="outline"
            onClick={() => {
              setQuery('');
              setTypeFilter('all');
            }}
          >
            {tp('empty.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={selectedVault ? tp('empty.vaultTitle') : tp('empty.title')}
        description={selectedVault ? tp('empty.vaultDescription') : tp('empty.description')}
        action={
          canAdd ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setDialog({ kind: 'create' })}>
                <Plus className="mr-1.5 h-4 w-4" />
                {tp('toolbar.addItem')}
              </Button>
              <Button variant="outline" onClick={() => setDialog({ kind: 'import' })}>
                <Upload className="mr-1.5 h-4 w-4" />
                {tp('toolbar.import')}
              </Button>
            </div>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ItemTable
        items={visibleItems}
        vaultsById={vaultsById}
        vaultLabel={vaultLabel}
        onOpen={(item) => setSearch({ item: item.id }, { replace: false })}
      />
    );
  }

  const showToolbar = !loading && !loadError && !isNonMemberView(selectedVault);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{tp('title')}</h1>
          <p className="text-sm text-muted-foreground">{tp('subtitle')}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/weldpass/passwords/health">
            <HeartPulse className="mr-1.5 h-4 w-4" />
            {tp('toolbar.health')}
          </Link>
        </Button>
      </header>

      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <VaultSidebar
          vaults={vaults}
          counts={counts}
          totalCount={items.length}
          selectedVaultId={selectedVault?.id ?? null}
          vaultLabel={vaultLabel}
          canCreate={canCreateVault}
          onSelect={(vaultId) => setSearch({ vault: vaultId ?? undefined })}
          onCreate={() => setDialog({ kind: 'newVault' })}
          onOpenSettings={(vault) => setDialog({ kind: 'settings', vaultId: vault.id })}
          canAdministerVault={(vault) => canAdministerVault(vault, canManageAll)}
        />

        <section className="min-w-0 flex-1 space-y-3">
          {selectedVault?.description && (
            <p className="text-sm text-muted-foreground">{selectedVault.description}</p>
          )}

          {showToolbar && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tp('toolbar.search')}
                  aria-label={tp('toolbar.search')}
                  className="pl-8"
                />
              </div>
              <Tabs value={typeFilter} onValueChange={(value) => setTypeFilter(value as ItemTypeFilter)}>
                <TabsList>
                  {TYPE_FILTERS.map((filter) => (
                    <TabsTrigger key={filter} value={filter}>
                      {tp(`toolbar.filters.${filter}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {canAdd && (
                <>
                  <Button variant="outline" onClick={() => setDialog({ kind: 'import' })}>
                    <Upload className="mr-1.5 h-4 w-4" />
                    {tp('toolbar.import')}
                  </Button>
                  <Button onClick={() => setDialog({ kind: 'create' })}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    {tp('toolbar.addItem')}
                  </Button>
                </>
              )}
            </div>
          )}

          {body}
        </section>
      </div>

      {openItem && dialog === null && (
        <ItemDetailDialog
          item={openItem}
          vaultName={openItemVault ? vaultLabel(openItemVault) : ''}
          canEdit={canEditVault(openItemVault)}
          onClose={() => setSearch({ item: undefined })}
          onEdit={(revealed) => {
            setSearch({ item: undefined });
            setDialog({ kind: 'edit', item: revealed });
          }}
          onMove={(item) => {
            setSearch({ item: undefined });
            setDialog({ kind: 'move', item });
          }}
          onHistory={(item) => {
            setSearch({ item: undefined });
            setDialog({ kind: 'history', item });
          }}
        />
      )}

      {dialog?.kind === 'create' && createVaultId && (
        <ItemFormDialog
          vaults={writable}
          vaultLabel={vaultLabel}
          defaultVaultId={createVaultId}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            toast.success(tp('form.saved'));
          }}
        />
      )}

      {dialog?.kind === 'edit' && (
        <ItemFormDialog
          vaults={writable}
          vaultLabel={vaultLabel}
          defaultVaultId={dialog.item.vaultId}
          item={dialog.item}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            toast.success(tp('form.saved'));
          }}
        />
      )}

      {dialog?.kind === 'move' && (
        <MoveItemDialog
          item={dialog.item}
          targets={moveTargets(vaults, dialog.item.vaultId)}
          vaultLabel={vaultLabel}
          onClose={closeDialog}
          onMoved={() => {
            closeDialog();
            toast.success(tp('move.moved'));
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <ItemHistoryDialog
          item={dialog.item}
          onClose={closeDialog}
          onRestored={() => {
            closeDialog();
            toast.success(tp('history.restored'));
          }}
        />
      )}

      {dialog?.kind === 'import' && createVaultId && (
        <ImportDialog
          vaults={writable}
          vaultLabel={vaultLabel}
          defaultVaultId={createVaultId}
          onClose={closeDialog}
        />
      )}

      {dialog?.kind === 'newVault' && (
        <CreateVaultDialog
          onClose={closeDialog}
          onCreated={(vault) => {
            closeDialog();
            setSearch({ vault: vault.id });
          }}
        />
      )}

      {dialog?.kind === 'settings' && settingsVault && (
        <VaultSettingsDialog
          vault={settingsVault}
          canAdminister={canAdministerVault(settingsVault, canManageAll)}
          currentUserId={user?.id}
          onClose={closeDialog}
          onGone={(reason) => {
            closeDialog();
            if (selectedVault?.id === settingsVault.id) setSearch({ vault: undefined });
            toast.success(tp(reason === 'deleted' ? 'settings.deleted' : 'settings.left'));
          }}
        />
      )}
    </div>
  );
}
