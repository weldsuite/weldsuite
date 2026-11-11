/**
 * The add-block menu: every field type by category, plus statement, group and
 * (classic layout only) page break.
 */

import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import type { FormLayout } from '@weldsuite/forms-engine';
import { useI18n } from '@/lib/i18n/provider';
import { BLOCK_CATEGORIES, BLOCK_ICONS, type BlockKind } from '../../lib/block-types';

interface Props {
  layout: FormLayout;
  /** Only fields and statements can go inside a group. */
  insideGroup?: boolean;
  onAdd: (kind: BlockKind) => void;
  children: ReactNode;
  disabled?: boolean;
}

export function AddBlockMenu({ layout, insideGroup, onAdd, children, disabled }: Readonly<Props>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const names = t.weldforms.blockTypes as Record<string, string>;
  const categories = t.weldforms.blockCategories as Record<string, string>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <ScrollArea className="max-h-[26rem]">
          <div className="space-y-3 p-3">
            {BLOCK_CATEGORIES.map((category) => {
              const kinds = category.kinds.filter((kind) => {
                if (kind === 'page_break') return layout === 'classic' && !insideGroup;
                if (kind === 'group') return !insideGroup;
                return true;
              });
              if (kinds.length === 0) return null;
              return (
                <div key={category.id}>
                  <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">{categories[category.id]}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {kinds.map((kind) => {
                      const Icon = BLOCK_ICONS[kind];
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => {
                            onAdd(kind);
                            setOpen(false);
                          }}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">{names[kind]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
