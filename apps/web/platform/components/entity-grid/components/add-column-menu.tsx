import React, { useState } from 'react';
import { ArrowLeft, ChevronRight, Plus } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useTranslations } from '@weldsuite/i18n/client';
import { useGridContext } from '../context';
import type { GridColumnDef } from '../types';

const LIST_CLASS =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent';

function ColumnIcon<TEntity>({ col }: Readonly<{ col: GridColumnDef<TEntity> }>) {
  if (col.iconUrl) return <img src={col.iconUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />;
  return col.icon ? React.createElement(col.icon, { className: 'mr-0.5 h-4 w-4' }) : null;
}

function CreditBadge({ cost }: Readonly<{ cost: number }>) {
  return (
    <span className="flex items-center gap-0.5 text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border rounded-[5px] ml-1 px-1 py-0.5">
      {cost}
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-[12px] flex-shrink-0 -translate-y-[0.5px]">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    </span>
  );
}

/** "25 >" — how many sub-items an entry drills into. A click on it drills in. */
function DrillAffordance({ count, onDrill }: Readonly<{ count?: number; onDrill: () => void }>) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
      onClick={(e) => {
        // Don't let the item's own click add the column.
        e.preventDefault();
        e.stopPropagation();
        onDrill();
      }}
    >
      {count !== undefined && <span>{count}</span>}
      <ChevronRight className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * The Add-column picker. Hidden built-in columns are listed at the top level
 * (in column order), custom and enrichment columns in their own groups, and
 * "Create new attribute" is pinned below the list. A column whose sub-attributes are hidden
 * (`menuParentId`) shows their count and a chevron and drills into them in
 * place, with a back arrow (→ / ← work too).
 */
export function AddColumnMenu({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const { config, state, showColumn } = useGridContext();
  const { columns } = state;
  const [drilledInto, setDrilledInto] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [highlighted, setHighlighted] = useState('');

  const hiddenChildren = (parentId: string) =>
    columns.filter((c) => c.menuParentId === parentId && c.visible === false);
  // A parent stays listed while any of its sub-attributes can still be added,
  // even once the parent column itself is showing.
  const topLevelBuiltIns = columns.filter(
    (c) => !c.isCustom && !c.menuParentId && (c.visible === false || hiddenChildren(c.id).length > 0),
  );
  const hiddenCustomColumns = columns.filter((c) => c.visible === false && c.isCustom && !c.isEnrichField);
  const hiddenEnrichColumns = columns.filter((c) => c.visible === false && c.isEnrichField);
  const availableEnrichFields = config.availableEnrichFields ?? [];

  const drillInto = (id: string) => {
    setDrilledInto(id);
    setSearch('');
    setHighlighted('');
  };
  const back = () => {
    setDrilledInto(null);
    setSearch('');
    setHighlighted('');
  };
  const add = (id: string) => {
    showColumn(id);
    onClose();
  };
  const createAttribute = () => {
    config.onCreateAttribute?.();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (drilledInto && e.key === 'ArrowLeft' && search === '') {
      e.preventDefault();
      back();
      return;
    }
    if (drilledInto || e.key !== 'ArrowRight') return;
    const col = topLevelBuiltIns.find((c) => c.id === highlighted);
    if (col && hiddenChildren(col.id).length > 0) {
      e.preventDefault();
      drillInto(col.id);
    }
  };

  const parent = drilledInto ? columns.find((c) => c.id === drilledInto) : null;
  const placeholder = config.searchAttributesPlaceholder ?? t('sweep.entities.searchAttributesPlaceholder');

  return (
    <Command
      // Re-mounts the list on drill-in/back, so the highlight starts at the top.
      key={drilledInto ?? 'root'}
      value={highlighted}
      onValueChange={setHighlighted}
      onKeyDown={handleKeyDown}
    >
      <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
      <CommandList className={LIST_CLASS} style={{ maxHeight: '400px' }}>
        <CommandEmpty>{t('sweep.entities.noAttributesFound')}</CommandEmpty>
        {drilledInto ? (
          <>
            <CommandGroup forceMount>
              <CommandItem value="__back__" forceMount onSelect={back} className="text-muted-foreground">
                <ArrowLeft className="mr-0.5 h-4 w-4" />
                {parent?.name}
              </CommandItem>
            </CommandGroup>
            <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
            <CommandGroup>
              {hiddenChildren(drilledInto).map((col) => (
                <CommandItem key={col.id} value={col.id} keywords={[col.name]} onSelect={() => add(col.id)}>
                  <ColumnIcon col={col} />
                  {col.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : (
          <>
            {topLevelBuiltIns.length > 0 && (
              <CommandGroup>
                {topLevelBuiltIns.map((col) => {
                  const children = hiddenChildren(col.id);
                  return (
                    <CommandItem
                      key={col.id}
                      value={col.id}
                      keywords={[col.name]}
                      // The column itself when it's hidden, else its sub-attributes.
                      onSelect={() => (col.visible === false ? add(col.id) : drillInto(col.id))}
                    >
                      <ColumnIcon col={col} />
                      <span className="flex-1 truncate">{col.name}</span>
                      {children.length > 0 && <DrillAffordance count={children.length} onDrill={() => drillInto(col.id)} />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {hiddenCustomColumns.length > 0 && (
              <CommandGroup heading={t('sweep.entities.customAttributesHeading')}>
                {hiddenCustomColumns.map((col) => (
                  <CommandItem key={col.id} value={col.id} keywords={[col.name]} onSelect={() => add(col.id)}>
                    <ColumnIcon col={col} />
                    {col.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {(hiddenEnrichColumns.length > 0 || availableEnrichFields.length > 0) && (
              <CommandGroup heading={t('sweep.entities.enrichmentHeading')}>
                {hiddenEnrichColumns.map((col) => (
                  <CommandItem key={col.id} value={col.id} keywords={[col.name]} onSelect={() => add(col.id)}>
                    <ColumnIcon col={col} />
                    <span className="flex-1">{col.name}</span>
                    {col.creditCost != null && <CreditBadge cost={col.creditCost} />}
                  </CommandItem>
                ))}
                {availableEnrichFields.map((ef) => (
                  <CommandItem
                    key={`${ef.provider}_${ef.operation}`}
                    value={`${ef.provider}_${ef.operation}`}
                    keywords={[ef.name]}
                    onSelect={() => {
                      config.onEnableEnrichField?.(ef.provider, ef.operation);
                      onClose();
                    }}
                  >
                    <img src={ef.logoUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />
                    <span className="flex-1">{ef.name}</span>
                    <CreditBadge cost={ef.creditCost} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
      {/* Pinned under the list (outside its scroll), so it's always in view. */}
      {config.onCreateAttribute && !drilledInto && (
        <div className="border-t p-1">
          <button
            type="button"
            onClick={createAttribute}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
          >
            <Plus className="mr-0.5 h-4 w-4" />
            <span className="flex-1">{t('sweep.entities.createNewAttribute')}</span>
          </button>
        </div>
      )}
    </Command>
  );
}
