/**
 * WeldPass vaults — every vault the caller is in, plus (for a workspace admin
 * holding `passwords:manage`) the shared vaults they are not a member of.
 *
 * Opening a vault shows its items on the Passwords page. The row menu's Edit
 * opens the vault settings: members, details, activity, leave and delete. A
 * vault the caller can manage but is not a member of has no items to show, so
 * its row opens the settings straight away.
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { LockKeyhole, SearchX } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useWeldPassVaults } from '@/hooks/queries/use-weldpass-passwords-queries';
import { formatDateTime } from '@/lib/utils';
import { emptyIcon, usePassBreadcrumbs } from '../../components/page-kit';
import { CreateVaultDialog } from '../components/create-vault-dialog';
import { PasswordsGate } from '../components/passwords-gate';
import { VaultSettingsDialog } from '../components/vault-settings-dialog';
import { canAdministerVault, filterVaults, isNonMemberView } from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';

export default function WeldPassVaultsPage() {
  return (
    <PasswordsGate pageLabel="WeldPass vaults">
      <VaultsList />
    </PasswordsGate>
  );
}

function VaultsList() {
  const tp = usePasswordsT();
  usePassBreadcrumbs({ label: tp('title'), href: '/weldpass/passwords' }, { label: tp('vaults.title') });

  const { can } = usePermissions();
  const { user } = useUser();
  const navigate = useNavigate();
  const { data, isLoading, error } = useWeldPassVaults();

  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsVaultId, setSettingsVaultId] = useState<string | null>(null);

  const canManageAll = can('passwords:manage');
  const canCreate = can('passwords:create') || canManageAll;

  // A personal vault is shown by a translated label, never its stored name.
  // Keyed on the label itself, so it follows a language switch.
  const personalLabel = tp('vaults.personal');
  const vaultLabel = useCallback(
    (vault: WeldPassVault) => (vault.kind === 'personal' ? personalLabel : vault.name),
    [personalLabel],
  );

  const vaults = useMemo(
    () => filterVaults(data ?? [], query, vaultLabel),
    [data, query, vaultLabel],
  );
  const settingsVault = settingsVaultId
    ? (data ?? []).find((vault) => vault.id === settingsVaultId)
    : undefined;

  function openItems(vault: WeldPassVault) {
    void navigate({ to: '/weldpass/passwords', search: { vault: vault.id } });
  }

  const columns: ColumnDef<WeldPassVault>[] = [
    {
      id: 'name',
      header: tp('vaults.columns.name'),
      width: 'flex-1',
      render: (vault) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{vaultLabel(vault)}</span>
          {vault.description && (
            <span className="block truncate text-xs text-muted-foreground">
              {vault.description}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'role',
      header: tp('vaults.columns.role'),
      width: 'w-[130px]',
      render: (vault) =>
        vault.role === null ? (
          <Badge variant="warning">{tp('vaults.notAMember')}</Badge>
        ) : (
          <Badge variant="secondary">{tp(`roles.${vault.role}`)}</Badge>
        ),
    },
    {
      id: 'members',
      header: tp('vaults.columns.members'),
      width: 'hidden md:block md:w-[90px]',
      render: (vault) => (
        <span className="text-muted-foreground">
          {vault.kind === 'personal' ? '—' : (vault.memberCount ?? 0)}
        </span>
      ),
    },
    {
      id: 'items',
      header: tp('vaults.columns.items'),
      width: 'hidden md:block md:w-[90px]',
      render: (vault) => (
        <span className="text-muted-foreground">
          {vault.role === null ? '—' : (vault.itemCount ?? 0)}
        </span>
      ),
    },
    {
      id: 'updated',
      header: tp('vaults.columns.updated'),
      width: 'hidden md:block md:w-[200px]',
      render: (vault) => (
        <span className="whitespace-nowrap font-mono text-sm text-muted-foreground">
          {formatDateTime(vault.updatedAt)}
        </span>
      ),
    },
  ];

  const createButton = canCreate
    ? { label: tp('vaults.newVault'), onClick: () => setCreating(true) }
    : undefined;

  return (
    <>
      <PanelEntityList<WeldPassVault>
        items={vaults}
        isLoading={isLoading}
        error={error as Error | null}
        columns={columns}
        onRowClick={(vault) => {
          if (isNonMemberView(vault)) setSettingsVaultId(vault.id);
          else openItems(vault);
        }}
        // The personal vault has no settings; there Edit just opens its items.
        onEdit={(vault) => {
          if (vault.kind === 'shared') setSettingsVaultId(vault.id);
          else openItems(vault);
        }}
        searchQuery={query}
        onSearchChange={setQuery}
        searchFields={['name']}
        searchPlaceholder={tp('vaults.search')}
        createButton={createButton}
        emptyState={
          query.trim()
            ? {
                icon: emptyIcon(SearchX),
                title: tp('vaults.noResultsTitle'),
                description: tp('vaults.noResultsDescription'),
              }
            : {
                icon: emptyIcon(LockKeyhole),
                title: tp('vaults.emptyTitle'),
                description: tp('vaults.emptyDescription'),
                action: createButton,
              }
        }
      />

      {creating && (
        <CreateVaultDialog
          onClose={() => setCreating(false)}
          onCreated={(vault) => {
            setCreating(false);
            openItems(vault);
          }}
        />
      )}

      {settingsVault && (
        <VaultSettingsDialog
          vault={settingsVault}
          canAdminister={canAdministerVault(settingsVault, canManageAll)}
          currentUserId={user?.id}
          onClose={() => setSettingsVaultId(null)}
          onGone={(reason) => {
            setSettingsVaultId(null);
            toast.success(tp(reason === 'deleted' ? 'settings.deleted' : 'settings.left'));
          }}
        />
      )}
    </>
  );
}
