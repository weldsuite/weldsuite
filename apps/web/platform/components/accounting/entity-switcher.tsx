import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { Building2, ChevronDown, Check, Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { CreateEntityDialog } from './create-entity-dialog';

interface EntityRow {
  id: string;
  name: string;
  legalName?: string | null;
  jurisdictionCode: string;
  baseCurrency: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
}

/**
 * Dropdown for switching between legal entities in the accounting module.
 * Writes selection to the persistent Jotai atom — the worker-client automatically
 * picks it up and sends `X-Accounting-Entity-Id` on subsequent API requests.
 */
export function EntitySwitcher() {
  const t = useTranslations();
  const { entityId, setEntityId } = useCurrentAccountingEntity();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: entities = [] } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  // Auto-select the default entity on first load.
  useEffect(() => {
    if (!entityId && entities.length > 0) {
      const fallback = entities.find((e) => e.isDefault) ?? entities[0];
      setEntityId(fallback.id);
    }
  }, [entities, entityId, setEntityId]);

  const current = entities.find((e) => e.id === entityId);

  if (entities.length === 0) {
    return (
      <>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('sweep.weldbooks.entitySwitcher.createEntity')}
        </Button>
        <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} firstEntity />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Building2 className="h-4 w-4" />
            <span className="truncate max-w-[180px]">
              {current ? current.name : t('sweep.weldbooks.entitySwitcher.selectEntity')}
            </span>
            {current ? (
              <span className="text-muted-foreground text-xs">
                {current.jurisdictionCode} · {current.baseCurrency}
              </span>
            ) : null}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px]">
          <DropdownMenuLabel>{t('sweep.weldbooks.entitySwitcher.legalEntity')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {entities
            .filter((e) => e.isActive !== false)
            .map((e) => (
              <DropdownMenuItem key={e.id} onClick={() => setEntityId(e.id)}>
                <div className="flex items-start gap-2 w-full">
                  {e.id === entityId ? (
                    <Check className="h-4 w-4 mt-0.5 text-primary" />
                  ) : (
                    <span className="w-4" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{e.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {e.jurisdictionCode} · {e.baseCurrency}
                      {e.legalName ? ` · ${e.legalName}` : ''}
                    </div>
                  </div>
                  {e.isDefault ? (
                    <span className="text-[10px] uppercase text-muted-foreground">{t('sweep.weldbooks.entitySwitcher.default')}</span>
                  ) : null}
                </div>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('sweep.weldbooks.entitySwitcher.newEntity')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
