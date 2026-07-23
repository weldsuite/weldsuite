import { useEffect, useMemo, useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, Lock } from 'lucide-react';
import type { ObjectTemplate, ObjectTemplateEntityType } from '@weldsuite/app-api-client/schemas/object-templates';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { cn } from '@/lib/utils';
import { useCustomFields } from '@/hooks/queries/use-settings-queries';
import { getRegistration, TEMPLATE_REGISTRATIONS } from './registry';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(150),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(150)
    .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, dashes or underscores only'),
  description: z.string().max(500).optional(),
  fields: z.array(z.string().min(1)).min(1, 'Select at least one field'),
});

export type TemplateFormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Default object type — also the fixed type when editing. */
  entityType: ObjectTemplateEntityType;
  template: ObjectTemplate | null;
  onSubmit: (values: TemplateFormValues, entityType: ObjectTemplateEntityType) => void;
  isPending?: boolean;
  /** When creating, let the user choose the object type (the "All" view). */
  selectableEntity?: boolean;
}

interface FieldOption {
  slug: string;
  label: string;
  group: string;
  required: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function TemplateDialog({
  open,
  onOpenChange,
  entityType,
  template,
  onSubmit,
  isPending,
  selectableEntity = false,
}: Props) {
  const ts = getTranslations('settings');
  const tod = ts.objectTemplates.dialog;
  // The object type the template targets. Fixed when editing; user-selectable
  // when creating from the "All" view.
  const [selectedType, setSelectedType] = useState<string>(entityType);
  const entity = getRegistration(selectedType)!;
  const { data: customFields } = useCustomFields(selectedType);
  const [slugTouched, setSlugTouched] = useState(false);
  const showEntityPicker = selectableEntity && !template;

  const builtinOptions: FieldOption[] = useMemo(
    () =>
      entity.fields.map((f) => ({
        slug: f.slug,
        label: f.label,
        group: f.group,
        required: !!f.required,
      })),
    [entity],
  );

  const customOptions: FieldOption[] = useMemo(
    () =>
      (customFields ?? []).map((cf) => ({
        slug: `cf:${cf.slug}`,
        label: cf.name,
        group: cf.group ?? 'Custom',
        required: !!cf.required,
      })),
    [customFields],
  );

  const requiredSlugs = useMemo(
    () => [...builtinOptions, ...customOptions].filter((o) => o.required).map((o) => o.slug),
    [builtinOptions, customOptions],
  );

  const form = useForm<TemplateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      fields: [],
    },
  });

  // Hydrate the type + form whenever the dialog opens or the edited template
  // changes. Seeding the type and fields together (from the registration
  // directly, not the reactive `entity`) avoids a render race on open.
  // Intentionally NOT keyed on `entity`/`requiredSlugs` so switching the object
  // type mid-create doesn't wipe the name/slug the user already typed —
  // `changeType` reseeds just the field list, and required slugs are re-merged
  // on submit regardless.
  useEffect(() => {
    if (!open) return;
    const effective = template?.entityType ?? entityType;
    setSelectedType(effective);
    const reg = getRegistration(effective)!;
    const required = reg.fields.filter((f) => f.required).map((f) => f.slug);
    if (template) {
      form.reset({
        name: template.name,
        slug: template.slug,
        description: template.description ?? '',
        fields: Array.from(new Set([...required, ...template.fields])),
      });
      setSlugTouched(true);
    } else {
      form.reset({
        name: '',
        slug: '',
        description: '',
        fields: Array.from(new Set([...required, ...reg.defaultFields])),
      });
      setSlugTouched(false);
    }
  }, [open, template, entityType, form]);

  // Switching object type while creating: reseed the field selection to the new
  // type's defaults, preserving name/slug/description.
  const changeType = (next: string) => {
    setSelectedType(next);
    const reg = getRegistration(next)!;
    const required = reg.fields.filter((f) => f.required).map((f) => f.slug);
    form.setValue('fields', Array.from(new Set([...required, ...reg.defaultFields])), {
      shouldValidate: true,
    });
  };

  const watchedName = form.watch('name');
  useEffect(() => {
    if (!slugTouched && !template) {
      form.setValue('slug', slugify(watchedName), { shouldValidate: false });
    }
  }, [watchedName, slugTouched, template, form]);

  const grouped = useMemo(() => {
    const out = new Map<string, FieldOption[]>();
    for (const f of builtinOptions) {
      const list = out.get(f.group) ?? [];
      list.push(f);
      out.set(f.group, list);
    }
    if (customOptions.length) {
      out.set('Custom', customOptions);
    }
    return Array.from(out.entries());
  }, [builtinOptions, customOptions]);

  const selectedFields = form.watch('fields');

  const toggleField = (opt: FieldOption) => {
    if (opt.required) return; // required fields are locked on
    const current = form.getValues('fields');
    if (current.includes(opt.slug)) {
      form.setValue(
        'fields',
        current.filter((s) => s !== opt.slug),
        { shouldValidate: true },
      );
    } else {
      form.setValue('fields', [...current, opt.slug], { shouldValidate: true });
    }
  };

  // Re-ensure required slugs are always present on submit (defence-in-depth
  // against any state where the form value drifted).
  const handleSubmit = form.handleSubmit((values) => {
    const merged = Array.from(new Set([...requiredSlugs, ...values.fields]));
    onSubmit({ ...values, fields: merged }, selectedType);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {template ? tod.editTitle : tod.newTitle}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {showEntityPicker && (
            <div className="space-y-2">
              <Label>{tod.objectLabel}</Label>
              <div className="flex items-center gap-2">
                {TEMPLATE_REGISTRATIONS.map((reg) => {
                  const Icon = reg.icon;
                  const active = selectedType === reg.value;
                  return (
                    <Button
                      key={reg.value}
                      type="button"
                      variant="ghost"
                      onClick={() => changeType(reg.value)}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        active
                          ? 'border-primary bg-primary/5 text-foreground'
                          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {reg.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">{tod.nameLabel}</Label>
              <Input id="name" placeholder={tod.namePlaceholder} {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">{tod.slugLabel}</Label>
              <Input
                id="slug"
                placeholder={tod.slugPlaceholder}
                {...form.register('slug', { onChange: () => setSlugTouched(true) })}
                disabled={!!template}
              />
              {form.formState.errors.slug && (
                <p className="text-xs text-destructive">{form.formState.errors.slug.message}</p>
              )}
              {template && (
                <p className="text-xs text-muted-foreground">{tod.slugImmutable}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{tod.descriptionLabel}</Label>
            <Textarea
              id="description"
              rows={2}
              placeholder={tod.descriptionPlaceholder}
              {...form.register('description')}
            />
          </div>

          <div className="space-y-2">
            <Label>{tod.fieldsLabel}</Label>
            <div className="border rounded-md p-3 max-h-72 overflow-auto space-y-3">
              {grouped.map(([group, options]) => (
                <div key={group}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                    {group}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {options.map((opt) => {
                      const checked = selectedFields.includes(opt.slug) || opt.required;
                      const locked = opt.required;
                      return (
                        <Button
                          type="button"
                          key={opt.slug}
                          variant="ghost"
                          onClick={() => toggleField(opt)}
                          disabled={locked}
                          aria-pressed={checked}
                          className={cn(
                            'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-sm text-left transition-colors',
                            checked
                              ? 'border-primary bg-primary/5 text-foreground'
                              : 'border-border hover:bg-muted',
                            locked && 'cursor-not-allowed opacity-90',
                          )}
                          title={locked ? tod.requiredTitle : undefined}
                        >
                          <span className="flex items-center gap-1.5">
                            {opt.label}
                            {locked && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                <Lock className="h-2.5 w-2.5" />
                                {tod.requiredBadge}
                              </span>
                            )}
                          </span>
                          <Check className={cn('h-4 w-4', checked ? 'opacity-100' : 'opacity-0')} />
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {form.formState.errors.fields && (
              <p className="text-xs text-destructive">{form.formState.errors.fields.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {tod.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {template ? tod.save : tod.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
