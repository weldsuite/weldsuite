import { useMemo, useState } from 'react';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { Label } from '@weldsuite/ui/components/label';
import { useProductOptions, useProductSearch, type ProductOption } from '@/hooks/queries/use-weldbooks-tax-preview';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';

interface ProductPickerProps {
  id: string;
  /** The picked product's id, `''` for none. */
  value: string;
  /** What to show for the picked product when it is not among the loaded ones. */
  selectedLabel?: string;
  /** The user picked a product, or cleared it (null). */
  onSelect: (product: ProductOption | null) => void;
}

function toAutocompleteOption(product: ProductOption): AutocompleteOption {
  return { value: product.id, label: product.name, description: product.sku ?? undefined };
}

/**
 * Optional catalogue product of a line (US sales tax lines): the product's tax
 * class becomes the line's tax code, and its name and price fill the line when
 * it is still empty. The line stays editable; a line without a product is just
 * a custom line.
 */
export function ProductPicker({ id, value, selectedLabel, onSelect }: Readonly<ProductPickerProps>) {
  const td = useDocumentTexts().line;
  const { data: products } = useProductOptions(true);
  const searchProducts = useProductSearch();
  // Products found by a search, so a pick from them can be resolved too.
  const [searched, setSearched] = useState<ProductOption[]>([]);

  const byId = useMemo(() => {
    const map = new Map<string, ProductOption>();
    for (const product of [...(products ?? []), ...searched]) map.set(product.id, product);
    return map;
  }, [products, searched]);

  const options = useMemo(() => {
    const list = (products ?? []).map(toAutocompleteOption);
    if (value && !byId.has(value)) list.unshift({ value, label: selectedLabel || value });
    return list;
  }, [products, byId, value, selectedLabel]);

  const search = async (query: string): Promise<AutocompleteOption[]> => {
    const found = await searchProducts(query);
    setSearched((prev) => [...prev, ...found]);
    return found.map(toAutocompleteOption);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {td.product}
      </Label>
      <Autocomplete
        options={options}
        value={value}
        onValueChange={(next) => onSelect(next ? (byId.get(next) ?? null) : null)}
        onSearch={search}
        minSearchLength={2}
        debounceMs={300}
        placeholder={td.productPlaceholder}
        searchPlaceholder={td.productSearch}
        emptyText={td.productEmpty}
      />
    </div>
  );
}
