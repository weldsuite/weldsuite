/**
 * Category picker for filing a product into categories.
 *
 * Writes through the category-side endpoints (`POST /categories/:id/products`),
 * one call per selected category — the junction has a single owner so the
 * manual/automated rule lives in one place.
 *
 * Automated categories are listed but not selectable: their membership comes
 * from rules, and the API rejects a manual attach on one.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useCommerceCategories } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function CategoryPickerDialog({
  open,
  onOpenChange,
  existingIds,
  onConfirm,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onConfirm: (categoryIds: string[]) => Promise<void> | void;
  isSaving?: boolean;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = useMemo(() => ({ limit: 100, search: search || undefined }), [search]);
  const { data, isLoading } = useCommerceCategories(params);
  const rows = data?.data ?? [];
  const existing = useMemo(() => new Set(existingIds), [existingIds]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    await onConfirm([...selected]);
    setSelected(new Set());
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected(new Set());
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.linking.addCategoriesTitle}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.categories.searchPlaceholder}
            className="pl-8"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto rounded-md border">
          {isLoading && <p className="p-4 text-sm text-muted-foreground">{t.common.loading}</p>}
          {!isLoading && rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t.categories.empty}</p>
          )}
          {!isLoading &&
            rows.map((c) => {
              const alreadyIn = existing.has(c.id);
              const isAutomated = c.type === 'automated';
              const disabled = alreadyIn || isAutomated;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(c.id)}
                  className={cn(
                    'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0',
                    disabled ? 'opacity-50' : 'hover:bg-muted/50',
                  )}
                  // Nesting is shown by indent so a deep tree stays readable.
                  style={{ paddingLeft: 12 + (c.depth ?? 0) * 16 }}
                >
                  <Checkbox
                    checked={alreadyIn || selected.has(c.id)}
                    disabled={disabled}
                    className="pointer-events-none"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                  {isAutomated && (
                    <Badge variant="outline" className="text-[10px]">
                      {t.categoryType.automated}
                    </Badge>
                  )}
                  {alreadyIn && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {t.linking.alreadyAdded}
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc.actions.cancel}
          </Button>
          <Button type="button" disabled={selected.size === 0 || isSaving} onClick={handleConfirm}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t.linking.addSelected.replace('{count}', String(selected.size))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
