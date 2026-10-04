/**
 * The vault list: "All items", the personal vault, then each shared vault.
 *
 * Wide screens get a column; narrow ones get a select, so the table keeps the
 * whole width.
 */

import { Lock, Plus, Settings, User, Users, Vault as VaultIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { cn } from '@/lib/utils';
import { usePasswordsT } from '../lib/use-passwords-t';

/** Radix Select cannot hold an empty value, so "all vaults" gets a sentinel. */
const ALL = '__all__';

function VaultGlyph({ vault }: Readonly<{ vault: WeldPassVault }>) {
  if (vault.kind === 'personal') return <User className="h-4 w-4 shrink-0" aria-hidden />;
  if (vault.role === null) return <Lock className="h-4 w-4 shrink-0" aria-hidden />;
  return <Users className="h-4 w-4 shrink-0" aria-hidden />;
}

export function VaultSidebar({
  vaults,
  counts,
  totalCount,
  selectedVaultId,
  vaultLabel,
  canCreate,
  onSelect,
  onCreate,
  onOpenSettings,
  canAdministerVault,
}: Readonly<{
  vaults: WeldPassVault[];
  counts: Map<string, number>;
  totalCount: number;
  selectedVaultId: string | null;
  vaultLabel: (vault: WeldPassVault) => string;
  canCreate: boolean;
  onSelect: (vaultId: string | null) => void;
  onCreate: () => void;
  onOpenSettings: (vault: WeldPassVault) => void;
  canAdministerVault: (vault: WeldPassVault) => boolean;
}>) {
  const tp = usePasswordsT();
  const selected = vaults.find((vault) => vault.id === selectedVaultId);

  function memberText(vault: WeldPassVault) {
    const count = vault.memberCount ?? 0;
    return count === 1 ? tp('vaults.membersOne') : tp('vaults.members', { count });
  }

  return (
    <>
      {/* Narrow screens */}
      <div className="flex items-center gap-2 md:hidden">
        <Select
          value={selected?.id ?? ALL}
          onValueChange={(value) => onSelect(value === ALL ? null : value)}
        >
          <SelectTrigger className="flex-1" aria-label={tp('vaults.pick')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {tp('vaults.all')} ({totalCount})
            </SelectItem>
            {vaults.map((vault) => (
              <SelectItem key={vault.id} value={vault.id}>
                {vaultLabel(vault)} ({counts.get(vault.id) ?? vault.itemCount ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected?.kind === 'shared' && (
          <Button
            variant="outline"
            size="icon"
            onClick={() => onOpenSettings(selected)}
            aria-label={
              canAdministerVault(selected) ? tp('vaults.settings') : tp('vaults.membersTitle')
            }
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {canCreate && (
          <Button variant="outline" size="icon" onClick={onCreate} aria-label={tp('vaults.newVault')}>
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Wide screens */}
      <nav
        aria-label={tp('vaults.heading')}
        className="hidden w-60 shrink-0 flex-col gap-1 md:flex"
      >
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {tp('vaults.heading')}
          </h2>
          {canCreate && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              onClick={onCreate}
              aria-label={tp('vaults.newVault')}
              title={tp('vaults.newVault')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-current={!selected ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            !selected ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-muted/60',
          )}
        >
          <VaultIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{tp('vaults.all')}</span>
          <span className="text-xs text-muted-foreground">{totalCount}</span>
        </button>

        {vaults.map((vault) => (
          <div
            key={vault.id}
            className={cn(
              'group flex items-center rounded-md transition-colors',
              vault.id === selected?.id
                ? 'bg-secondary font-medium'
                : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(vault.id)}
              aria-current={vault.id === selected?.id ? 'page' : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
            >
              <VaultGlyph vault={vault} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{vaultLabel(vault)}</span>
                {vault.kind === 'shared' && (
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {memberText(vault)}
                  </span>
                )}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {vault.role === null ? '' : (counts.get(vault.id) ?? vault.itemCount ?? 0)}
              </span>
            </button>
            {vault.kind === 'shared' && (
              <Button
                variant="ghost"
                size="sm"
                className="mr-1 h-7 px-1.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onOpenSettings(vault)}
                aria-label={
                  canAdministerVault(vault)
                    ? tp('vaults.settingsFor', { vault: vault.name })
                    : tp('vaults.membersFor', { vault: vault.name })
                }
                title={canAdministerVault(vault) ? tp('vaults.settings') : tp('vaults.membersTitle')}
              >
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </nav>
    </>
  );
}
