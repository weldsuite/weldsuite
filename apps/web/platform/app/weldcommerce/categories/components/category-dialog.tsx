import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  createProductCategorySchema,
  type CreateProductCategoryInput,
} from '@weldsuite/app-api-client/schemas/product-categories';
import {
  useCreateCommerceCategory,
  useUpdateCommerceCategory,
  useCommerceCategoryTree,
  flattenCategoryTree,
  type CommerceCategory,
} from '@/hooks/queries/use-commerce-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

type FormValues = z.input<typeof createProductCategorySchema>;

const NO_PARENT = '__none__';

/**
 * Create + edit form for a category. Creates `manual` categories only — an
 * `automated` one is rejected unless it carries at least one rule, and there
 * is no rule builder yet, so offering the type would produce a form that
 * can't submit.
 */
export function CategoryDialog({
  open,
  onOpenChange,
  category,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: CommerceCategory;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!category;
  const create = useCreateCommerceCategory();
  const update = useUpdateCommerceCategory();
  // Tree-ordered so the picker reads as a hierarchy rather than a flat list.
  const { data: tree } = useCommerceCategoryTree();

  const form = useForm<FormValues>({
    resolver: zodResolver(createProductCategorySchema),
    defaultValues: category
      ? {
          name: category.name,
          slug: category.slug ?? undefined,
          description: category.description ?? undefined,
          parentId: category.parentId ?? undefined,
          position: category.position ?? undefined,
          isActive: category.isActive ?? true,
        }
      : { name: '', isActive: true },
  });

  // A category can't be its own parent. Its descendants are excluded too:
  // re-parenting under your own child is the cycle the API rejects, and an
  // option that always errors shouldn't be offered. `path` makes the subtree
  // test a prefix check — no walking required.
  const allCategories = useMemo(() => flattenCategoryTree(tree?.data ?? []), [tree]);
  const parentOptions = useMemo(() => {
    if (!category) return allCategories;
    const selfPath = category.path;
    return allCategories.filter((c) => {
      if (c.id === category.id) return false;
      if (selfPath && c.path?.startsWith(selfPath)) return false;
      return true;
    });
  }, [allCategories, category]);

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createProductCategorySchema.parse(values) as CreateProductCategoryInput;
      if (isEdit && category) {
        await update.mutateAsync({ id: category.id, data: parsed });
        toast.success(t.categories.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.categories.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.categories.editTitle : t.categories.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">{t.fields.name}</Label>
            <Input id="name" {...form.register('name')} />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{String(form.formState.errors.name.message ?? '')}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="slug">{t.fields.slug}</Label>
              <Input id="slug" {...form.register('slug')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="position">{t.fields.position}</Label>
              <Input id="position" type="number" {...form.register('position', { valueAsNumber: true })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="parentId">{t.fields.parent}</Label>
            <Select
              defaultValue={category?.parentId ?? NO_PARENT}
              onValueChange={(v) => form.setValue('parentId', v === NO_PARENT ? undefined : v)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARENT}>{t.categories.noParent}</SelectItem>
                {parentOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {/* Non-breaking spaces: SelectItem renders plain text, so
                        padding can't come from the layout here. */}
                    {' '.repeat((c.depth ?? 0) * 2)}
                    {(c.depth ?? 0) > 0 ? '└ ' : ''}
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.fields.description}</Label>
            <Textarea id="description" rows={3} {...form.register('description')} />
          </div>
          <p className="text-xs text-muted-foreground">{t.categories.automatedHint}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc.actions.cancel}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {isEdit ? tc.actions.save : tc.actions.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
