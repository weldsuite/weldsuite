/**
 * Product picker for attaching products to a manual category.
 *
 * `_shared/record-selection-modal.tsx` can't be reused: it's typed to
 * `RecordKind` (company / person) and queries CRM surfaces.
 *
 * Products already attached are shown disabled rather than hidden — hiding
 * them makes it look like the search is broken when you go looking for one you
 * already added.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useCommerceProducts } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function ProductPickerDialog({
  open,
  onOpenChange,
  existingIds,
  onConfirm,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onConfirm: (productIds: string[]) => Promise<void> | void;
  isSaving?: boolean;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = useMemo(() => ({ limit: 50, search: search || undefined }), [search]);
  const { data, isLoading } = useCommerceProducts(params);
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
          <DialogTitle>{t.linking.addProductsTitle}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.products.searchPlaceholder}
            className="pl-8"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto rounded-md border">
          {isLoading && (
            <p className="p-4 text-sm text-muted-foreground">{t.common.loading}</p>
          )}
          {!isLoading && rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t.products.empty}</p>
          )}
          {!isLoading &&
            rows.map((p) => {
              const alreadyIn = existing.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={alreadyIn}
                  onClick={() => toggle(p.id)}
                  className={cn(
                    'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0',
                    alreadyIn ? 'opacity-50' : 'hover:bg-muted/50',
                  )}
                >
                  <Checkbox
                    checked={alreadyIn || selected.has(p.id)}
                    disabled={alreadyIn}
                    className="pointer-events-none"
                  />
                  {p.featuredImageUrl ? (
                    <img
                      src={p.featuredImageUrl}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded object-cover bg-muted"
                    />
                  ) : (
                    <div className="h-8 w-8 shrink-0 rounded bg-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {p.name}
                    {p.sku && <span className="text-muted-foreground"> · {p.sku}</span>}
                  </span>
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
