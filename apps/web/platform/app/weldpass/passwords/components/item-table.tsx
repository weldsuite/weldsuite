/** The item list. Titles, usernames and sites only — never a secret. */

import { ShieldCheck } from 'lucide-react';
import { Card } from '@weldsuite/ui/components/card';
import type {
  WeldPassItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { TimeAgo } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';
import { ItemTypeIcon } from './item-type-icon';

export function ItemTable({
  items,
  vaultsById,
  vaultLabel,
  onOpen,
}: Readonly<{
  items: WeldPassItem[];
  vaultsById: Map<string, WeldPassVault>;
  vaultLabel: (vault: WeldPassVault) => string;
  onOpen: (item: WeldPassItem) => void;
}>) {
  const tp = usePasswordsT();

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">{tp('table.name')}</th>
            <th className="hidden px-4 py-2 font-medium sm:table-cell">{tp('table.details')}</th>
            <th className="hidden px-4 py-2 font-medium md:table-cell">{tp('table.vault')}</th>
            <th className="hidden px-4 py-2 font-medium lg:table-cell">{tp('table.updated')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const vault = vaultsById.get(item.vaultId);
            return (
              <tr
                key={item.id}
                className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                onClick={() => onOpen(item)}
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2.5 text-left font-medium"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(item);
                    }}
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                      title={tp(`types.${item.type}`)}
                    >
                      <ItemTypeIcon type={item.type} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{item.title}</span>
                      {/* On narrow screens the details column is hidden. */}
                      <span className="block truncate text-xs font-normal text-muted-foreground sm:hidden">
                        {item.subtitle || item.host}
                      </span>
                    </span>
                    {item.hasTotp && (
                      <ShieldCheck
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-label={tp('table.hasTotp')}
                      />
                    )}
                  </button>
                </td>
                <td className="hidden max-w-64 px-4 py-2.5 sm:table-cell">
                  <p className="truncate">{item.subtitle || '—'}</p>
                  {item.host && (
                    <p className="truncate text-xs text-muted-foreground">{item.host}</p>
                  )}
                </td>
                <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
                  {vault ? vaultLabel(vault) : '—'}
                </td>
                <td className="hidden px-4 py-2.5 text-xs lg:table-cell">
                  <TimeAgo value={item.updatedAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
