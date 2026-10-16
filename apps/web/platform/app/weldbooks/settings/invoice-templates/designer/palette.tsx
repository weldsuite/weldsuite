import type { InvoiceTemplateDocument, TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';
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

/** The blocks that can be added to the page: click to add near the top-left of the view, or drag onto the page. */
export function BlockPalette({ doc, readOnly, onAdd }: Readonly<PaletteProps>) {
  const { t } = useI18n();
  const tp = t.accounting.invoiceTemplates.palette;
  const names = t.accounting.invoiceTemplates.blocks as Record<TemplateBlockType, string>;

  return (
    <div className="space-y-4 p-3">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tp.title}</h2>
        {readOnly ? null : <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{tp.hint}</p>}
      </div>
      {PALETTE_GROUPS.map((group) => (
        <div key={group.key} className="space-y-1.5">
          <h3 className="text-[11px] font-medium text-muted-foreground">{tp.groups[group.key]}</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {group.types.map((type) => {
              const Icon = BLOCK_ICONS[type];
              const blockedByRule = !canAddBlock(doc, type);
              const disabled = readOnly || blockedByRule;
              const button = (
                <button
                  type="button"
                  disabled={disabled}
                  draggable={!disabled}
                  aria-label={tp.add.replace('{block}', names[type])}
                  onClick={() => onAdd(type)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(BLOCK_DRAG_TYPE, type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left text-xs outline-none transition-colors',
                    'hover:border-primary/50 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    disabled ? 'cursor-not-allowed opacity-50 hover:border-border hover:bg-background' : 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{names[type]}</span>
                </button>
              );
              if (!blockedByRule) return <div key={type}>{button}</div>;
              return (
                <Tooltip key={type}>
                  <TooltipTrigger asChild>
                    <div>{button}</div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-60">{tp.lineItemsExists}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
