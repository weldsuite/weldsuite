import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { useObjectPanel, useObjectPanelNavigationSource } from '@/components/object-panel';
import { SectionHeader, ProseBlock, LineItemList } from '@/components/objects/_shared/simple-object-panel';
import { useProductCategories } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';

/**
 * The Categories tab of the product panel (WeldCommerce): the categories the
 * product was filed under by hand. A row opens that category's panel on top,
 * so the back chevron returns to the product.
 */
export function ProductCategoriesSection({ productId }: Readonly<{ productId: string }>) {
  const t = getTranslations('commerce');
  const tp = t.productCategories;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useProductCategories(productId);
  const rows = data?.data ?? [];
  // Previous / next in the category panel step through these categories.
  useObjectPanelNavigationSource({ type: 'category', ids: rows.map((c) => c.id) });

  if (isLoading) return <InlineSpinner />;
  if (error) return <InlineError className="mx-4 my-3">{tp.loadFailed}</InlineError>;

  return (
    <div className="space-y-2 pb-3">
      <SectionHeader>{tp.tab}</SectionHeader>
      {rows.length === 0 ? (
        <ProseBlock>{tp.empty}</ProseBlock>
      ) : (
        <LineItemList
          items={rows}
          getKey={(c) => c.id}
          renderLeft={(c) => (
            <button
              type="button"
              className="truncate text-left hover:underline"
              // The indent mirrors the tree depth, so nesting shows here too.
              style={{ paddingLeft: (c.depth ?? 0) * 12 }}
              onClick={() => open({ type: 'category', id: c.id, stack: true })}
            >
              {c.name}
            </button>
          )}
          renderRight={(c) => (c.isActive ? t.status.active : t.status.inactive)}
        />
      )}
      <p className="px-4 text-xs text-muted-foreground">{tp.manualOnly}</p>
    </div>
  );
}
