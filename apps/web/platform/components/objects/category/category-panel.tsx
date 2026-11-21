/**
 * Category object panel.
 *
 * Tabs are category-specific rather than the CRM default set:
 *
 *   overview      → the category record, and an automated category's rules
 *   products      → `/categories/:id/products` — its members
 *   subcategories → `/categories?parentId=:id` — direct children
 *
 * Members are resolved server-side: the products added by hand for a
 * `manual` category, a live rule query for an `automated` one. Only a manual
 * category's members can be added and removed here (`categories:update`).
 */

import { useState } from 'react';
import { Plus, X, Package, FolderTree } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useObjectPanel, useObjectPanelNavigationSource } from '@/components/object-panel';
import {
  useCommerceCategory,
  useCommerceCategories,
  useCommerceCategoryProducts,
  useAttachCategoryProducts,
  useDetachCategoryProduct,
  type CategoryRuleColumn,
  type CategoryRuleRelation,
  type CommerceProduct,
} from '@/hooks/queries/use-commerce-queries';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
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
import { ProductPickerDialog } from './product-picker-dialog';

export function CategoryPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = getTranslations('commerce');
  const tc = t.categories;
  const { id } = props;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useCommerceCategory(id);
  const category = data?.data;

  const members = useCommerceCategoryProducts(id, !!category);
  const memberRows: CommerceProduct[] = members.data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const memberCount = members.data?.pages[0]?.pagination?.totalCount ?? memberRows.length;

  const { data: children } = useCommerceCategories({ parentId: id, limit: 100 }, !!category);
  const childRows = children?.data ?? [];

  // Previous / next in the product and category panels step through these rows.
  useObjectPanelNavigationSource({
    type: 'product',
    ids: memberRows.map((p) => p.id),
    hasMore: !!members.hasNextPage,
    loadMore: () => void members.fetchNextPage(),
  });
  useObjectPanelNavigationSource({ type: 'category', ids: childRows.map((c) => c.id) });

  const permissions = usePermissionsMaybe();
  const canEdit = permissions?.can('categories:update') ?? false;
  const attach = useAttachCategoryProducts();
  const detach = useDetachCategoryProduct();
  const [pickerOpen, setPickerOpen] = useState(false);

  // An automated category's members come from its rules; the API refuses a
  // manual add or remove on one, so the panel doesn't offer it.
  const isManual = category?.type !== 'automated';
  const canChangeMembers = isManual && canEdit;
  const columnLabels: Record<CategoryRuleColumn, string> = tc.rules.columns;
  const relationLabels: Record<CategoryRuleRelation, string> = tc.rules.relations;

  const handleAttach = async (productIds: string[]) => {
    try {
      await attach.mutateAsync({ categoryId: id, productIds });
      toast.success(plural(productIds.length, tc.panel.productsAdded, getLocale()));
    } catch (err) {
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const handleDetach = async (productId: string) => {
    try {
      await detach.mutateAsync({ categoryId: id, productId });
      toast.success(tc.panel.productRemoved);
    } catch (err) {
      toast.error(errorMessage(err, t.common.deleteFailed));
    }
  };

  const renderProducts = () => (
    <div className="space-y-2 pb-3">
      <div className="flex items-center justify-between pr-4">
        <SectionHeader>{tc.panel.members}</SectionHeader>
        {canChangeMembers && (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setPickerOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {tc.panel.addProducts}
          </Button>
        )}
      </div>

      {!isManual && <p className="px-4 text-xs text-muted-foreground">{tc.panel.automatedMembers}</p>}

      {memberRows.length === 0 ? (
        <ProseBlock>{tc.panel.noProducts}</ProseBlock>
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
                  width={24}
                  height={24}
                  loading="lazy"
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
              {canChangeMembers && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label={fill(tc.panel.removeFromCategory, { name: p.name })}
                  title={fill(tc.panel.removeFromCategory, { name: p.name })}
                  onClick={() => void handleDetach(p.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </span>
          )}
        />
      )}

      {members.hasNextPage && (
        <div className="px-4">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
          >
            {t.common.loadMore}
          </Button>
        </div>
      )}
    </div>
  );

  const renderSubcategories = () => {
    if (childRows.length === 0) return <ProseBlock>{tc.panel.noSubcategories}</ProseBlock>;
    return (
      <div className="space-y-2">
        <SectionHeader>{tc.panel.tabSubcategories}</SectionHeader>
        <LineItemList
          items={childRows}
          getKey={(c) => c.id}
          // Drilling into a child stacks its panel, so the back chevron walks back up the tree.
          renderLeft={(c) => (
            <button
              type="button"
              className="truncate text-left hover:underline"
              onClick={() => open({ type: 'category', id: c.id, stack: true })}
            >
              {c.name}
            </button>
          )}
          renderRight={(c) => (c.isActive ? t.status.active : t.status.inactive)}
        />
      </div>
    );
  };

  const rules = category?.type === 'automated' ? category.rules ?? [] : [];

  return (
    <>
      {canChangeMembers && (
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
        openHref={category ? `/weldcommerce/categories?stack=category:${encodeURIComponent(category.id)}` : undefined}
        tabs={[
          detailsTab(tc.panel.tabDetails),
          { ...extraTab('products', tc.panel.tabProducts, Package), count: memberCount || undefined },
          {
            ...extraTab('subcategories', tc.panel.tabSubcategories, FolderTree),
            count: childRows.length || undefined,
            // A leaf category has no children: no always-empty tab.
            hidden: childRows.length === 0,
          },
        ]}
        renderTab={(tabId) => {
          if (tabId === 'products') return renderProducts();
          if (tabId === 'subcategories') return renderSubcategories();
          return null;
        }}
        statusBadges={
          category && (
            <>
              <Badge variant="outline">{category.type === 'automated' ? tc.type.automated : tc.type.manual}</Badge>
              <SoftBadge tone={category.isActive ? 'success' : 'neutral'}>
                {category.isActive ? t.status.active : t.status.inactive}
              </SoftBadge>
            </>
          )
        }
        fields={
          category
            ? [
                { label: tc.fields.slug, value: category.slug },
                { label: tc.fields.products, value: memberCount },
                { label: tc.fields.subcategories, value: childRows.length },
                { label: tc.fields.created, value: formatPanelDate(category.createdAt), tabular: true },
              ]
            : []
        }
        extras={
          category && (category.description || rules.length > 0) ? (
            <div className="space-y-3">
              {rules.length > 0 && (
                <div className="space-y-1">
                  <SectionHeader>{tc.rules.title}</SectionHeader>
                  <p className="px-4 text-xs text-muted-foreground">
                    {category.rulesMatch === 'any' ? tc.panel.matchAny : tc.panel.matchAll}
                  </p>
                  <ul className="mx-4 list-disc space-y-0.5 pl-4 text-sm">
                    {rules.map((rule) => (
                      <li key={`${rule.column}-${rule.relation}-${rule.condition}`}>
                        {columnLabels[rule.column] ?? rule.column} {relationLabels[rule.relation] ?? rule.relation}{' '}
                        <span className="font-medium">{rule.condition}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {category.description && (
                <div className="space-y-1">
                  <SectionHeader>{tc.fields.description}</SectionHeader>
                  <ProseBlock>{category.description}</ProseBlock>
                </div>
              )}
            </div>
          ) : undefined
        }
      />
    </>
  );
}
