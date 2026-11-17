/**
 * The add-block popup: a search field over every field type by category, plus
 * statement, group and (classic layout only) page break. Enter in the search
 * adds the first match.
 */

import { useState, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { SearchInput } from '@weldsuite/ui/components/search-input';
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
  const to = t.weldforms.outline;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const names = t.weldforms.blockTypes as Record<string, string>;
  const categoryNames = t.weldforms.blockCategories as Record<string, string>;

  // A search matches a type's name, or its category's, which lists the whole category.
  const needle = query.trim().toLowerCase();
  const categories = BLOCK_CATEGORIES.map((category) => {
    const allowed = category.kinds.filter((kind) => {
      if (kind === 'page_break') return layout === 'classic' && !insideGroup;
      if (kind === 'group') return !insideGroup;
      return true;
    });
    const categoryMatches = categoryNames[category.id]?.toLowerCase().includes(needle);
    const kinds = needle === '' || categoryMatches ? allowed : allowed.filter((kind) => names[kind]?.toLowerCase().includes(needle));
    return { id: category.id, kinds };
  }).filter((category) => category.kinds.length > 0);

  function setOpenState(next: boolean) {
    setOpen(next);
    if (!next) setQuery('');
  }

  function add(kind: BlockKind) {
    onAdd(kind);
    setOpenState(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      <DialogTrigger asChild disabled={disabled}>
        {children}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{insideGroup ? to.addToGroup : to.addBlock}</DialogTitle>
        </DialogHeader>
        <SearchInput
          className="w-full"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = categories[0]?.kinds[0];
            if (e.key === 'Enter' && needle !== '' && first) {
              e.preventDefault();
              add(first);
            }
          }}
          placeholder={to.searchBlocks}
          aria-label={to.searchBlocks}
        />
        <div className="-mx-1 h-[min(65vh,640px)] overflow-y-auto px-1 pb-1">
          {categories.length === 0 ? (
            <EmptyText>{to.noBlockTypes.replace('{query}', query.trim())}</EmptyText>
          ) : (
            <div className="space-y-5">
              {categories.map((category) => (
                <section key={category.id}>
                  <h3 className="pb-2 text-xs font-medium text-muted-foreground">{categoryNames[category.id]}</h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {category.kinds.map((kind) => {
                      const Icon = BLOCK_ICONS[kind];
                      return (
                        <Button key={kind} type="button" variant="outline" className="justify-start font-normal" onClick={() => add(kind)}>
                          <Icon className="text-muted-foreground" aria-hidden />
                          <span className="truncate">{names[kind]}</span>
                        </Button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
