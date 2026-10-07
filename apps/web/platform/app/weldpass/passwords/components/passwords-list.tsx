/**
 * WeldPass item list — the rows of the Passwords page and of a single vault.
 *
 * `PanelEntityList` is the whole page, like the other modules' lists. On the
 * Passwords page it shows every item: search, "vault" and "type" filter pills,
 * items grouped by vault, with the vault filter and the opened item in the URL
 * (`?vault=…&item=…`) so a reload keeps them and a link can point at a vault or
 * one login. Given a `vaultId` it is the inside of that vault instead: only its
 * items, no vault filter, grouping or column, and only `?item=` in the URL.
 *
 * Lists carry no secrets. A password is fetched only when the user presses
 * Reveal, Copy or Edit (see item-detail-dialog.tsx); every such fetch is
 * recorded on the vault's trail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ChevronLeft, LockKeyhole, Lock, SearchX, ShieldCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
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
import { formatDateTime } from '@/lib/utils';
import { emptyIcon, usePassBreadcrumbs } from '../../components/page-kit';
import { ImportDialog } from './import-dialog';
import { ItemDetailDialog } from './item-detail-dialog';
import { ItemFormDialog } from './item-form-dialog';
import { MoveItemDialog } from './move-item-dialog';
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
} from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; item: WeldPassRevealedItem }
  | { kind: 'move'; item: WeldPassItem }
  | { kind: 'import' }
  | null;

type PasswordsSearch = { vault?: string; item?: string };

/** The "vault is …" pill that mirrors `?vault=`. */
function vaultLinkPill(vaultId: string): ActiveFilter {
  return { id: 'vault-link', field: VAULT_FILTER, operator: 'is', value: vaultId };
}

/** `vaultId` narrows the list to the inside of one vault; without it, every item. */
export function PasswordsList({ vaultId: scopedVaultId }: Readonly<{ vaultId?: string }>) {
  const t = useTranslations();
  const tp = usePasswordsT();

  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PasswordsSearch;
  // Inside a vault the route is the vault; `?vault=` plays no part.
  const urlVault = scopedVaultId ? undefined : search.vault;

  const vaultsQuery = useWeldPassVaults();
  const itemsQuery = useWeldPassItems();
  const [query, setQuery] = useState('');
  const [pills, setPills] = useState<ActiveFilter[]>(() =>
    withVaultPill([], urlVault, vaultLinkPill),
  );
  const [dialog, setDialog] = useState<Dialog>(null);

  const vaults = useMemo(() => sortVaults(vaultsQuery.data ?? []), [vaultsQuery.data]);
  const vaultsById = useMemo(() => new Map(vaults.map((vault) => [vault.id, vault])), [vaults]);
  const scopedVault = scopedVaultId ? vaultsById.get(scopedVaultId) : undefined;
  const items = useMemo(() => {
    const all = itemsQuery.data ?? [];
    return scopedVaultId ? all.filter((item) => item.vaultId === scopedVaultId) : all;
  }, [itemsQuery.data, scopedVaultId]);

  // A personal vault is shown by a translated label, never its stored name.
  // Keyed on the label itself, so it follows a language switch.
  const personalLabel = tp('vaults.personal');
  const vaultLabel = useCallback(
    (vault: WeldPassVault) => (vault.kind === 'personal' ? personalLabel : vault.name),
    [personalLabel],
  );

  usePassBreadcrumbs(
    { label: tp('title'), href: scopedVaultId ? '/weldpass/passwords' : undefined },
    scopedVaultId ? { label: tp('vaults.title'), href: '/weldpass/passwords/vaults' } : null,
    scopedVault && { label: vaultLabel(scopedVault) },
  );

  const setSearch = useCallback(
    (patch: PasswordsSearch, options: { replace?: boolean } = {}) => {
      const merge = (previous: PasswordsSearch) => ({ ...previous, ...patch });
      const replace = options.replace ?? true;
      if (scopedVaultId) {
        void navigate({
          to: '/weldpass/passwords/vaults/$vaultId',
          params: { vaultId: scopedVaultId },
          search: merge,
          replace,
        });
      } else {
        void navigate({ to: '/weldpass/passwords', search: merge, replace });
      }
    },
    [navigate, scopedVaultId],
  );

  // The vault pill and `?vault=` are two views of one thing. A pill the user
  // edits is written to the URL below; a URL that changes on its own (a link,
  // the Vaults page, the back button) is copied into the pills here. Only a
  // change of the URL itself triggers this, so it cannot undo a pill edit that
  // the URL has not caught up with yet.
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
    if (scopedVaultId) return;
    const vaultId = vaultIdFromPills(next);
    if (vaultId !== urlVault) setSearch({ vault: vaultId });
  }

  const selectedVault =
    (scopedVaultId ? scopedVault : vaultsById.get(vaultIdFromPills(pills) ?? '')) ?? null;
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
    ...(scopedVaultId
      ? []
      : [
          {
            field: VAULT_FILTER,
            label: tp('filters.vault'),
            options: vaults.map((vault) => ({ value: vault.id, label: vaultLabel(vault) })),
          },
        ]),
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

  const allColumns: ColumnDef<WeldPassItem>[] = [
    {
      id: 'title',
      header: tp('table.name'),
      width: 'flex-1',
      render: (item) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{item.title}</span>
          {item.hasTotp && (
            <ShieldCheck
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-label={tp('table.hasTotp')}
            />
          )}
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
      width: 'hidden md:block md:w-[200px]',
      render: (item) => (
        <span className="whitespace-nowrap font-mono text-sm text-muted-foreground">
          {formatDateTime(item.updatedAt)}
        </span>
      ),
    },
  ];

  const columns = scopedVaultId
    ? allColumns.filter((column) => column.id !== 'vault')
    : allColumns;

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

  // A vault that is gone (deleted, left, or a stale link) has no inside to show.
  if (scopedVaultId && vaultsQuery.isSuccess && !scopedVault) {
    return <Navigate to="/weldpass/passwords/vaults" replace />;
  }

  return (
    <>
      <PanelEntityList<WeldPassItem>
        items={visibleItems}
        isLoading={vaultsQuery.isLoading || itemsQuery.isLoading}
        error={error}
        columns={columns}
        groups={scopedVaultId ? undefined : groups}
        onRowClick={(item) => setSearch({ item: item.id }, { replace: false })}
        filters={filterConfigs}
        activeFilters={pills}
        onFiltersChange={changePills}
        searchQuery={query}
        onSearchChange={setQuery}
        searchFields={['title']}
        searchPlaceholder={tp('toolbar.search')}
        createButton={createButton}
        // The slot sits after the filter pills; a back arrow belongs before
        // them. Styled as the Filter button it sits next to.
        leftActionButtons={
          scopedVaultId ? (
            <Button
              asChild
              variant="outline"
              size="icon"
              className="order-first h-8 w-8 shadow-none text-muted-foreground"
            >
              <Link to="/weldpass/passwords/vaults" aria-label={t('common.actions.back')}>
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
          ) : undefined
        }
        actionButtons={
          canAdd ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setDialog({ kind: 'import' })}
            >
              {tp('toolbar.import')}
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
          onRestored={() => toast.success(tp('history.restored'))}
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
