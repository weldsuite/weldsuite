import type { InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';
import type { ActiveFilter } from '@/components/entity-list';

/** Keeps the templates that match every active filter ("is" / "is not" on paper size and default). */
export function applyTemplateFilters(items: InvoiceTemplate[], filters: ActiveFilter[]): InvoiceTemplate[] {
  return items.filter((template) =>
    filters.every((filter) => {
      if (!filter.value) return true;
      let value: string | null = null;
      if (filter.field === 'paperSize') value = template.document.paperSize;
      else if (filter.field === 'default') value = template.isDefault ? 'yes' : 'no';
      if (value === null) return true;
      return filter.operator === 'is not' ? value !== filter.value : value === filter.value;
    }),
  );
}
