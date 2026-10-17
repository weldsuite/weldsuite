import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { InvoiceTemplateDocument, TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';
import { Input } from '@weldsuite/ui/components/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { BLOCK_ICONS } from './block-icons';
import { BLOCK_DRAG_TYPE } from './canvas';
import { PALETTE_GROUPS, canAddBlock } from './model/block-factory';

interface PaletteProps {
  doc: InvoiceTemplateDocument;
  readOnly: boolean;
  onAdd: (type: TemplateBlockType) => void;
}

interface TileProps {
  type: TemplateBlockType;
  name: string;
  label: string;
  disabled: boolean;
  onAdd: (type: TemplateBlockType) => void;
}

/** One block: icon over its name. Click adds it near the top-left of the view; drag drops it where it is let go. */
function BlockTile({ type, name, label, disabled, onAdd }: Readonly<TileProps>) {
  const Icon = BLOCK_ICONS[type];
  return (
    <button
      type="button"
      disabled={disabled}
      draggable={!disabled}
      aria-label={label}
      onClick={() => onAdd(type)}
      onDragStart={(e) => {
        e.dataTransfer.setData(BLOCK_DRAG_TYPE, type);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={cn(
        'group flex h-[72px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-transparent bg-muted/50 px-2 text-center outline-none transition-colors',
        'hover:border-border hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        disabled ? 'cursor-not-allowed opacity-40 hover:border-transparent hover:bg-muted/50' : 'cursor-grab active:cursor-grabbing',
      )}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" strokeWidth={1.75} aria-hidden />
      <span className="line-clamp-2 text-[11px] leading-tight text-foreground">{name}</span>
    </button>
  );
}

/** The blocks that can be added to the page, grouped, with a search. */
export function BlockPalette({ doc, readOnly, onAdd }: Readonly<PaletteProps>) {
  const { t } = useI18n();
  const tp = t.accounting.invoiceTemplates.palette;
  const names = t.accounting.invoiceTemplates.blocks as Record<TemplateBlockType, string>;
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return PALETTE_GROUPS.map((group) => ({
      ...group,
      types: q ? group.types.filter((type) => names[type].toLocaleLowerCase().includes(q)) : group.types,
    })).filter((group) => group.types.length > 0);
  }, [names, query]);

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tp.search}
          aria-label={tp.search}
          className="h-8 pl-8 text-sm shadow-none"
        />
      </div>

      {groups.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{tp.noResults.replace('{query}', query.trim())}</p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp.groups[group.key]}</h3>
            <div className="grid grid-cols-3 gap-2">
              {group.types.map((type) => {
                const blockedByRule = !canAddBlock(doc, type);
                const tile = (
                  <BlockTile
                    type={type}
                    name={names[type]}
                    label={tp.add.replace('{block}', names[type])}
                    disabled={readOnly || blockedByRule}
                    onAdd={onAdd}
                  />
                );
                if (!blockedByRule) return <div key={type}>{tile}</div>;
                return (
                  <Tooltip key={type}>
                    <TooltipTrigger asChild>
                      <div>{tile}</div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-60">{tp.lineItemsExists}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </section>
        ))
      )}

    </div>
  );
}
