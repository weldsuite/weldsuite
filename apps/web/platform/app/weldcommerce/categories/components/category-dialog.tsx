import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  useCommerceCategoryTree,
  useCreateCommerceCategory,
  useUpdateCommerceCategory,
  type CategoryInput,
  type CategoryRule,
  type CategoryRulesMatch,
  type CommerceCategory,
} from '@/hooks/queries/use-commerce-queries';
import { formSchemaOptions, optionalText } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import { cleanRules, flattenCategoryTree, newRule, rulesAreComplete, subtreeIds } from '../../lib/categories';
import { errorMessage } from '../../lib/text';
import { CategoryRulesEditor } from './category-rules-editor';

const NO_PARENT = '__none__';

const categoryFormSchema = z.object({
  name: z.string().trim().min(1).max(255),
  slug: z.string().trim().max(255).optional(),
  description: z.string().max(5000).optional(),
  parentId: z.string().nullable(),
  isActive: z.boolean(),
  type: z.enum(['manual', 'automated']),
});

type FormValues = z.infer<typeof categoryFormSchema>;

/**
 * What the form sends. A new category leaves out what is blank; an edit sends
 * a cleared description as null and `parentId: null` to move to the top
 * level. An automated category carries its rules; one turned manual drops them.
 */
export function categoryPayload(
  values: FormValues,
  rules: CategoryRule[],
  rulesMatch: CategoryRulesMatch,
  existing?: CommerceCategory,
): CategoryInput {
  const description = values.description?.trim() || undefined;
  const body: CategoryInput = { name: values.name, isActive: values.isActive, type: values.type };
  if (values.slug) body.slug = values.slug;
  if (existing) {
    body.parentId = values.parentId;
    if (description !== (existing.description ?? undefined)) body.description = description ?? null;
  } else {
    if (values.parentId) body.parentId = values.parentId;
    if (description) body.description = description;
  }
  if (values.type === 'automated') {
    body.rules = cleanRules(rules);
    body.rulesMatch = rulesMatch;
  } else if (existing?.type === 'automated') {
    body.rules = null;
    body.rulesMatch = null;
  }
  return body;
}

/**
 * Create and edit form for a category: name, slug, parent, description,
 * active, and its type. A manual category gets its products by hand (in its
 * panel); an automated one takes every product its rules match, previewed
 * live under the rules.
 */
export function CategoryDialog({
  open,
  onOpenChange,
  category,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: CommerceCategory;
}>) {
  const t = getTranslations('commerce');
  const tc = t.categories;
  const common = getTranslations('common');
  const isEdit = !!category;
  const create = useCreateCommerceCategory();
  const update = useUpdateCommerceCategory();
  // Tree-ordered, so the parent picker reads as a hierarchy.
  const { data: tree } = useCommerceCategoryTree();

  const form = useForm<FormValues>({
    resolver: zodResolver(categoryFormSchema, formSchemaOptions()),
    defaultValues: {
      name: category?.name ?? '',
      slug: category?.slug || undefined,
      description: category?.description ?? undefined,
      parentId: category?.parentId ?? null,
      isActive: category?.isActive ?? true,
      type: category?.type ?? 'manual',
    },
  });
  const { errors, isSubmitting } = form.formState;
  const type = form.watch('type');
  const isActive = form.watch('isActive');

  // The rules are not form inputs: the editor keeps them, and they are
  // checked on submit (an automated category needs at least one, all complete).
  const [rules, setRules] = useState<CategoryRule[]>(() => category?.rules ?? []);
  const [rulesMatch, setRulesMatch] = useState<CategoryRulesMatch>(category?.rulesMatch ?? 'all');
  const [rulesChecked, setRulesChecked] = useState(false);
  const rulesBox = useRef<HTMLDivElement>(null);

  // A category can't move under itself or one of its descendants.
  const parentOptions = useMemo(() => {
    const nodes = tree?.data ?? [];
    const all = flattenCategoryTree(nodes);
    if (!category) return all;
    const excluded = subtreeIds(nodes, category.id);
    return all.filter((c) => !excluded.has(c.id));
  }, [tree, category]);

  const changeType = (next: string) => {
    const value = next === 'automated' ? 'automated' : 'manual';
    form.setValue('type', value, { shouldDirty: true });
    // Start an automated category with one rule to fill in.
    if (value === 'automated' && rules.length === 0) setRules([newRule()]);
  };

  const onSubmit = async (values: FormValues) => {
    if (values.type === 'automated' && !rulesAreComplete(rules)) {
      // Render the rule errors now, then move focus to the first one (or to Add rule when there
      // are none), as a failed submit should: the form is noValidate, so the browser won't.
      flushSync(() => setRulesChecked(true));
      const box = rulesBox.current;
      (box?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? box?.querySelector<HTMLElement>('[data-add-rule]'))?.focus();
      return;
    }
    try {
      const body = categoryPayload(values, rules, rulesMatch, category);
      if (isEdit && category) {
        await update.mutateAsync({ id: category.id, data: body });
        toast.success(tc.toastUpdated);
      } else {
        await create.mutateAsync(body);
        toast.success(tc.toastCreated);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{isEdit ? tc.editTitle : tc.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="category-name">{tc.fields.name}</Label>
            <Input
              id="category-name"
              required
              aria-invalid={!!errors.name || undefined}
              aria-describedby={errors.name ? 'category-name-error' : undefined}
              {...form.register('name')}
            />
            <FieldError id="category-name-error" className="text-xs" errors={[errors.name]} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="category-slug">{tc.fields.slug}</Label>
              {/* A slug is a code, not words: no spellcheck, capitals or autocorrect. */}
              <Input
                id="category-slug"
                placeholder={tc.fields.slugHint}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={!!errors.slug || undefined}
                aria-describedby={errors.slug ? 'category-slug-error' : undefined}
                {...form.register('slug', optionalText)}
              />
              <FieldError id="category-slug-error" className="text-xs" errors={[errors.slug]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="category-parent">{tc.fields.parent}</Label>
              <Select
                defaultValue={category?.parentId ?? NO_PARENT}
                onValueChange={(v) => form.setValue('parentId', v === NO_PARENT ? null : v, { shouldDirty: true })}
              >
                <SelectTrigger id="category-parent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>{tc.noParent}</SelectItem>
                  {parentOptions.map((c) => (
                    // textValue: type-to-select matches the name, not the indent in front of it.
                    <SelectItem key={c.id} value={c.id} textValue={c.name}>
                      {/* SelectItem renders plain text, so the indent is non-breaking spaces. */}
                      {' '.repeat((c.depth ?? 0) * 3)}
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="category-description">{tc.fields.description}</Label>
            <Textarea
              id="category-description"
              rows={3}
              aria-invalid={!!errors.description || undefined}
              aria-describedby={errors.description ? 'category-description-error' : undefined}
              {...form.register('description')}
            />
            <FieldError id="category-description-error" className="text-xs" errors={[errors.description]} />
          </div>

          <div className="flex items-start gap-3">
            <Switch
              id="category-active"
              aria-describedby="category-active-hint"
              checked={isActive}
              onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
            />
            <div className="grid gap-0.5">
              <Label htmlFor="category-active">{tc.fields.active}</Label>
              <p id="category-active-hint" className="text-xs text-muted-foreground">
                {tc.fields.activeHint}
              </p>
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{tc.fields.type}</legend>
            <RadioGroup value={type} onValueChange={changeType} className="grid gap-2 sm:grid-cols-2">
              {(['manual', 'automated'] as const).map((value) => (
                <label
                  key={value}
                  htmlFor={`category-type-${value}`}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-primary"
                >
                  {/* The whole card is the label, but the radio's name is the type alone; the hint is its description. */}
                  <RadioGroupItem
                    id={`category-type-${value}`}
                    value={value}
                    className="mt-0.5"
                    aria-labelledby={`category-type-${value}-name`}
                    aria-describedby={`category-type-${value}-hint`}
                  />
                  <span className="grid gap-0.5">
                    <span id={`category-type-${value}-name`} className="text-sm font-medium">
                      {tc.type[value]}
                    </span>
                    <span id={`category-type-${value}-hint`} className="text-xs text-muted-foreground">
                      {tc.typeHint[value]}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>

          {type === 'automated' && (
            <div ref={rulesBox} className="grid gap-2">
              <h3 className="text-sm font-medium">{tc.rules.title}</h3>
              <CategoryRulesEditor
                rules={rules}
                rulesMatch={rulesMatch}
                showErrors={rulesChecked}
                onChange={(next) => {
                  setRules(next.rules);
                  setRulesMatch(next.rulesMatch);
                }}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {common.actions.cancel}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isEdit ? common.actions.save : common.actions.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
