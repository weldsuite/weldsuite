/**
 * Category object panel.
 *
 * Tabs are category-specific rather than the CRM default set:
 *
 *   overview      → the category record
 *   products      → `/categories/:id/products` — resolved members
 *   subcategories → `/categories?parentId=:id` — direct children
 *
 * Members are resolved server-side: the junction table for `manual`
 * categories, a live rule query for `automated` ones. The panel doesn't care
 * which — it renders whatever the endpoint returns.
 */

import { useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Package, FolderTree, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useObjectPanel } from '@/components/object-panel';
import {
  useCommerceCategory,
  useCommerceCategoryProducts,
  useCommerceSubcategories,
  useAttachCategoryProducts,
  useDetachCategoryProduct,
} from '@/hooks/queries/use-commerce-queries';
import { ProductPickerDialog } from './product-picker-dialog';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { detailsTab, extraTab } from '@/components/objects/_shared/focused-tabs';

export function CategoryPanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('commerce').module;
  const { id } = props;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useCommerceCategory(id);
  const category = data?.data;

  const { data: members } = useCommerceCategoryProducts(id, !!category);
  const memberRows = members?.data ?? [];

  const { data: children } = useCommerceSubcategories(id, !!category);
  const childRows = children?.data ?? [];

  const attach = useAttachCategoryProducts();
  const detach = useDetachCategoryProduct();
  const [pickerOpen, setPickerOpen] = useState(false);

  // An automated category's members come from its rules; the API rejects a
  // manual attach on one, so the UI must not offer it.
  const isManual = category?.type !== 'automated';

  const handleAttach = async (productIds: string[]) => {
    try {
      await attach.mutateAsync({ categoryId: id, productIds });
      toast.success(t.linking.productsAdded.replace('{count}', String(productIds.length)));
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  const handleDetach = async (productId: string) => {
    try {
      await detach.mutateAsync({ categoryId: id, productId });
      toast.success(t.linking.productRemoved);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
    {isManual && (
      <ProductPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingIds={memberRows.map((p) => p.id)}
        onConfirm={handleAttach}
        isSaving={attach.isPending}
      />
    )}
    <SimpleObjectPanel
      {...props}
      objectType="category"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!category}
      title={category?.name}
      subtitle={category?.slug ?? undefined}
      openHref={category ? `/weldcommerce/categories?open=${category.id}` : undefined}
      tabs={[
        detailsTab(t.panel.tabDetails),
        { ...extraTab('products', t.panel.tabProducts, Package), count: memberRows.length || undefined },
        {
          ...extraTab('subcategories', t.panel.tabSubcategories, FolderTree),
          count: childRows.length || undefined,
          // A leaf category has no children — don't show an always-empty tab.
          hidden: childRows.length === 0,
        },
      ]}
      renderTab={(tabId) => {
        if (tabId === 'products') {
          return (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-4 pt-3">
                <SectionHeader>{t.categories.members}</SectionHeader>
                {isManual && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t.linking.addProducts}
                  </Button>
                )}
              </div>

              {!isManual && (
                <p className="px-4 text-xs text-muted-foreground">{t.linking.automatedMembers}</p>
              )}

              {memberRows.length === 0 ? (
                <ProseBlock>{t.panel.noProducts}</ProseBlock>
              ) : (
                <LineItemList
                  items={memberRows}
                  getKey={(p) => p.id}
                  renderLeft={(p) => (
                    <span className="flex min-w-0 items-center gap-2">
                      {p.featuredImageUrl ? (
                        <img
                          src={p.featuredImageUrl}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded object-cover bg-muted"
                        />
                      ) : null}
                      <button
                        type="button"
                        className="truncate text-left hover:underline"
                        onClick={() => open({ type: 'product', id: p.id, stack: true })}
                      >
                        {p.name}
                        {p.sku ? <span className="text-muted-foreground"> · {p.sku}</span> : null}
                      </button>
                    </span>
                  )}
                  renderRight={(p) => (
                    <span className="flex items-center gap-2">
                      {formatPanelMoney(p.price, p.currency) ?? '—'}
                      {isManual && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          title={t.linking.removeFromCategory}
                          onClick={() => void handleDetach(p.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  )}
                />
              )}
            </div>
          );
        }

        if (tabId === 'subcategories') {
          if (childRows.length === 0) return <ProseBlock>{t.panel.noSubcategories}</ProseBlock>;
          return (
            <div className="space-y-2">
              <SectionHeader>{t.panel.tabSubcategories}</SectionHeader>
              <LineItemList
                items={childRows}
                getKey={(c) => c.id}
                // Drilling into a child stacks its panel, so the back chevron
                // walks back up the tree.
                renderLeft={(c) => (
                  <button
                    type="button"
                    className="truncate text-left hover:underline"
                    onClick={() => open({ type: 'category', id: c.id, stack: true })}
                  >
                    {c.name}
                  </button>
                )}
                renderRight={(c) =>
                  c.isActive === false ? t.status.inactive : t.status.active
                }
              />
            </div>
          );
        }

        return null;
      }}
      statusBadges={
        category && (
          <>
            <Badge variant="outline" className="capitalize">
              {category.type === 'automated' ? t.categoryType.automated : t.categoryType.manual}
            </Badge>
            <Badge variant={category.isActive === false ? 'secondary' : 'default'}>
              {category.isActive === false ? t.status.inactive : t.status.active}
            </Badge>
          </>
        )
      }
      fields={
        category
          ? [
              { label: t.fields.slug, value: category.slug },
              { label: t.fields.position, value: category.position },
              { label: t.fields.memberCount, value: memberRows.length },
              { label: t.panel.tabSubcategories, value: childRows.length },
              { label: t.fields.created, value: formatPanelDate(category.createdAt) },
            ]
          : []
      }
      extras={
        category?.description ? (
          <div className="space-y-1">
            <SectionHeader>{t.fields.description}</SectionHeader>
            <ProseBlock>{category.description}</ProseBlock>
          </div>
        ) : undefined
      }
    />
    </>
  );
}
