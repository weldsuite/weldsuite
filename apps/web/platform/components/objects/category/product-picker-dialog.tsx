/**
 * Product picker for adding products to a manual category.
 *
 * `_shared/record-selection-modal.tsx` can't be reused: it's typed to
 * `RecordKind` (company / person) and queries CRM surfaces.
 *
 * Products already in the category are shown disabled rather than hidden —
 * hiding them makes it look like the search is broken when you go looking
 * for one you already added.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useDebounce } from '@/hooks/use-debounce';
import { useWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';

export function ProductPickerDialog({
  open,
  onOpenChange,
  existingIds,
  onConfirm,
  isSaving,
  title,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onConfirm: (productIds: string[]) => Promise<void> | void;
  isSaving?: boolean;
  /** The dialog's heading; defaults to the category wording. */
  title?: string;
}>) {
  const t = getTranslations('commerce').categories.picker;
  const tc = getTranslations('common');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search.trim(), 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = useMemo(() => ({ limit: 50, search: debouncedSearch || undefined }), [debouncedSearch]);
  const { data, isLoading } = useWeldstashProducts(params);
  const rows = data?.data ?? [];
  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  // Said after each search, for whoever can't see the list change.
  const found = debouncedSearch && !isLoading ? plural(data?.pagination?.totalCount ?? rows.length, t.found, getLocale()) : '';

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const close = (next: boolean) => {
    if (!next) setSelected(new Set());
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    await onConfirm([...selected]);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title ?? t.title}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            type="search"
            aria-label={t.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchPlaceholder}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="pl-8"
          />
        </div>
        <p role="status" className="sr-only">
          {found}
        </p>

        <div className="max-h-[320px] overflow-y-auto rounded-md border">
          {isLoading && <InlineSpinner className="py-6" />}
          {!isLoading && rows.length === 0 && <EmptyText>{t.empty}</EmptyText>}
          {!isLoading &&
            rows.map((p) => {
              const alreadyIn = existing.has(p.id);
              const checkboxId = `product-picker-${p.id}`;
              // A label around the checkbox: the whole row toggles it, and the
              // checkbox stays the one control (no button inside a button).
              return (
                <label
                  key={p.id}
                  htmlFor={checkboxId}
                  className={cn(
                    'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0',
                    alreadyIn ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-muted/50',
                  )}
                >
                  <Checkbox
                    id={checkboxId}
                    checked={alreadyIn || selected.has(p.id)}
                    disabled={alreadyIn}
                    onCheckedChange={() => toggle(p.id)}
                  />
                  {p.featuredImageUrl ? (
                    // Up to 50 rows in a scroll box: load the thumbnails as they scroll into view.
                    <img
                      src={p.featuredImageUrl}
                      alt=""
                      width={32}
                      height={32}
                      loading="lazy"
                      className="h-8 w-8 shrink-0 rounded object-cover bg-muted"
                    />
                  ) : (
                    <span className="h-8 w-8 shrink-0 rounded bg-muted" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {p.name}
                    {p.sku && <span className="text-muted-foreground"> · {p.sku}</span>}
                  </span>
                  {alreadyIn && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      {t.alreadyAdded}
                    </span>
                  )}
                </label>
              );
            })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {tc.actions.cancel}
          </Button>
          <Button type="button" disabled={selected.size === 0 || isSaving} onClick={() => void handleConfirm()}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {selected.size === 0 ? t.add : plural(selected.size, t.addCount, getLocale())}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
