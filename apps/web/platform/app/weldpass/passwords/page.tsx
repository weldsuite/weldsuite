/**
 * WeldPass passwords — the team password manager's item list.
 *
 * `PanelEntityList` is the whole page, like the other modules' lists: search,
 * "vault" and "type" filter pills, items grouped by vault. The vault filter and
 * the opened item live in the URL (`?vault=…&item=…`) so a reload keeps them and
 * a link can point at a vault or one login. Vaults themselves are managed on
 * the Vaults page.
 *
 * Lists carry no secrets. A password is fetched only when the user presses
 * Reveal, Copy or Edit (see item-detail-dialog.tsx); every such fetch is
 * recorded on the vault's trail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { LockKeyhole, Lock, SearchX, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type {
  WeldPassItem,
  WeldPassRevealedItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import {
  useWeldPassItems,
  useWeldPassVaults,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { TimeAgo } from '../components/shared';
import { emptyIcon, usePassBreadcrumbs } from '../components/page-kit';
import { PasswordsGate } from './components/passwords-gate';
import { ImportDialog } from './components/import-dialog';
import { ItemDetailDialog } from './components/item-detail-dialog';
import { ItemFormDialog } from './components/item-form-dialog';
import { ItemHistoryDialog } from './components/item-history-dialog';
import { ItemTypeIcon } from './components/item-type-icon';
import { MoveItemDialog } from './components/move-item-dialog';
import {
  TYPE_FILTER,
  VAULT_FILTER,
  buildVaultGroups,
  canEditVault,
  defaultCreateVaultId,
  filterItems,
  isFiltering,
  isNonMemberView,
  moveTargets,
  sortVaults,
  vaultIdFromPills,
  withVaultPill,
  writableVaults,
} from './lib/items';
import { usePasswordsT } from './lib/use-passwords-t';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; item: WeldPassRevealedItem }
  | { kind: 'move'; item: WeldPassItem }
  | { kind: 'history'; item: WeldPassItem }
  | { kind: 'import' }
  | null;

type PasswordsSearch = { vault?: string; item?: string };

/** The "vault is …" pill that mirrors `?vault=`. */
function vaultLinkPill(vaultId: string): ActiveFilter {
  return { id: 'vault-link', field: VAULT_FILTER, operator: 'is', value: vaultId };
}

export default function WeldPassPasswordsPage() {
  return (
    <PasswordsGate pageLabel="WeldPass passwords">
      <PasswordsList />
    </PasswordsGate>
  );
}

function PasswordsList() {
  const tp = usePasswordsT();
  usePassBreadcrumbs({ label: tp('title') });

  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PasswordsSearch;

  const vaultsQuery = useWeldPassVaults();
  const itemsQuery = useWeldPassItems();
  const [query, setQuery] = useState('');
  const [pills, setPills] = useState<ActiveFilter[]>(() =>
    withVaultPill([], search.vault, vaultLinkPill),
  );
  const [dialog, setDialog] = useState<Dialog>(null);


  const vaults = useMemo(() => sortVaults(vaultsQuery.data ?? []), [vaultsQuery.data]);
  const vaultsById = useMemo(() => new Map(vaults.map((vault) => [vault.id, vault])), [vaults]);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);

  // A personal vault is shown by a translated label, never its stored name.
  // Keyed on the label itself, so it follows a language switch.
  const personalLabel = tp('vaults.personal');
  const vaultLabel = useCallback(
    (vault: WeldPassVault) => (vault.kind === 'personal' ? personalLabel : vault.name),
    [personalLabel],
  );

  const setSearch = useCallback(
    (patch: PasswordsSearch, options: { replace?: boolean } = {}) => {
      void navigate({
        to: '/weldpass/passwords',
        search: (previous: PasswordsSearch) => ({ ...previous, ...patch }),
        replace: options.replace ?? true,
      });
    },
    [navigate],
  );

  // The vault pill and `?vault=` are two views of one thing. A pill the user
  // edits is written to the URL below; a URL that changes on its own (a link,
  // the Vaults page, the back button) is copied into the pills here. Only a
  // change of the URL itself triggers this, so it cannot undo a pill edit that
  // the URL has not caught up with yet.
  const urlVault = search.vault;
  const lastUrlVault = useRef(urlVault);
  useEffect(() => {
    if (lastUrlVault.current === urlVault) return;
    lastUrlVault.current = urlVault;
    setPills((previous) =>
      vaultIdFromPills(previous) === urlVault
        ? previous
        : withVaultPill(previous, urlVault, vaultLinkPill),
    );
  }, [urlVault]);

  function changePills(next: ActiveFilter[]) {
    setPills(next);
    const vaultId = vaultIdFromPills(next);
    if (vaultId !== urlVault) setSearch({ vault: vaultId });
  }

  const selectedVault = vaultsById.get(vaultIdFromPills(pills) ?? '') ?? null;
  const filter = useMemo(() => ({ pills, query }), [pills, query]);
  const visibleItems = useMemo(() => filterItems(items, filter), [items, filter]);

  const openItem = search.item ? items.find((item) => item.id === search.item) : undefined;
  const openItemVault = openItem ? vaultsById.get(openItem.vaultId) : undefined;

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

  const filterConfigs: FilterConfig[] = [
    {
      field: VAULT_FILTER,
      label: tp('filters.vault'),
      options: vaults.map((vault) => ({ value: vault.id, label: vaultLabel(vault) })),
    },
    {
      field: TYPE_FILTER,
      label: tp('filters.type'),
      options: (['login', 'note', 'card'] as const).map((type) => ({
        value: type,
        label: tp(`types.${type}`),
      })),
    },
  ];

  // Personal first, then shared vaults by name — the vault structure is
  // visible without a sidebar.
  const groups: GroupConfig<WeldPassItem>[] = useMemo(
    () => buildVaultGroups(vaults, vaultLabel),
    [vaults, vaultLabel],
  );

  const columns: ColumnDef<WeldPassItem>[] = [
    {
      id: 'title',
      header: tp('table.name'),
      width: 'flex-1',
      render: (item) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            title={tp(`types.${item.type}`)}
          >
            <ItemTypeIcon type={item.type} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium">{item.title}</span>
              {item.hasTotp && (
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label={tp('table.hasTotp')}
                />
              )}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {item.subtitle || '—'}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: 'site',
      header: tp('table.site'),
      width: 'hidden md:block md:w-[200px]',
      render: (item) => <span className="text-muted-foreground">{item.host ?? '—'}</span>,
    },
    {
      id: 'vault',
      header: tp('table.vault'),
      width: 'hidden lg:block lg:w-[160px]',
      render: (item) => {
        const vault = vaultsById.get(item.vaultId);
        return <span className="text-muted-foreground">{vault ? vaultLabel(vault) : '—'}</span>;
      },
    },
    {
      id: 'updated',
      header: tp('table.updated'),
      width: 'hidden md:block md:w-[120px]',
      render: (item) => <TimeAgo value={item.updatedAt} />,
    },
  ];

  const createButton = canAdd
    ? { label: tp('toolbar.addItem'), onClick: () => setDialog({ kind: 'create' }) }
    : undefined;

  const emptyState = (() => {
    if (selectedVault && isNonMemberView(selectedVault)) {
      return {
        icon: emptyIcon(Lock),
        title: tp('vaults.notMemberTitle'),
        description: tp('vaults.notMemberDescription'),
      };
    }
    if (selectedVault && !items.some((item) => item.vaultId === selectedVault.id)) {
      return {
        icon: emptyIcon(LockKeyhole),
        title: tp('empty.vaultTitle'),
        description: tp('empty.vaultDescription'),
        action: createButton,
      };
    }
    if (isFiltering(filter)) {
      return {
        icon: emptyIcon(SearchX),
        title: tp('empty.noResultsTitle'),
        description: tp('empty.noResultsDescription'),
      };
    }
    return {
      icon: emptyIcon(LockKeyhole),
      title: tp('empty.title'),
      description: tp('empty.description'),
      action: createButton,
    };
  })();

  const error = (vaultsQuery.error ?? itemsQuery.error) as Error | null;

  return (
    <>
      <PanelEntityList<WeldPassItem>
        items={visibleItems}
        isLoading={vaultsQuery.isLoading || itemsQuery.isLoading}
        error={error}
        columns={columns}
        groups={groups}
        onRowClick={(item) => setSearch({ item: item.id }, { replace: false })}
        filters={filterConfigs}
        activeFilters={pills}
        onFiltersChange={changePills}
        searchQuery={query}
        onSearchChange={setQuery}
        searchFields={['title']}
        searchPlaceholder={tp('toolbar.search')}
        createButton={createButton}
        actionButtons={
          canAdd ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setDialog({ kind: 'import' })}
            >
              <Upload className="h-4 w-4 md:mr-0.5" />
              <span className="hidden md:inline">{tp('toolbar.import')}</span>
            </Button>
          ) : undefined
        }
        emptyState={emptyState}
      />

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
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
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
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.success(tp('form.saved'));
          }}
        />
      )}

      {dialog?.kind === 'move' && (
        <MoveItemDialog
          item={dialog.item}
          targets={moveTargets(vaults, dialog.item.vaultId)}
          vaultLabel={vaultLabel}
          onClose={() => setDialog(null)}
          onMoved={() => {
            setDialog(null);
            toast.success(tp('move.moved'));
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <ItemHistoryDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onRestored={() => {
            setDialog(null);
            toast.success(tp('history.restored'));
          }}
        />
      )}

      {dialog?.kind === 'import' && createVaultId && (
        <ImportDialog
          vaults={writable}
          vaultLabel={vaultLabel}
          defaultVaultId={createVaultId}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
