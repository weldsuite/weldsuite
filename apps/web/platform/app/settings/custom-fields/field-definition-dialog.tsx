
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD_TYPES, getEntityTypeConfig, ENTITY_TYPES } from './entity-types';
import type { CustomFieldDefinition, UpdateCustomFieldData } from '@/lib/api/domains/settings';

const selectOptionSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  value: z.string().min(1, 'Value is required'),
  color: z.string().optional(),
});

const fieldSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z.string().min(1, 'Slug is required').max(100).regex(/^[a-z0-9_]+$/, 'Must be lowercase alphanumeric with underscores'),
  description: z.string().max(500).optional(),
  fieldType: z.string().min(1, 'Field type is required'),
  required: z.boolean().optional(),
  group: z.string().max(100).optional(),
  options: z.array(selectOptionSchema).optional(),
  config: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    currency: z.string().optional(),
    maxRating: z.number().optional(),
    entityType: z.string().optional(),
  }).optional(),
});

type FieldFormValues = z.infer<typeof fieldSchema>;

interface FieldDefinitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Default object type — also the fixed type when editing. */
  entityType: string;
  field: CustomFieldDefinition | null;
  onSubmit: (data: UpdateCustomFieldData & { slug?: string; entityType?: string }) => void;
  isPending: boolean;
  /** When creating, let the user choose the object type (the "All" view). */
  selectableEntity?: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100);
}

export function FieldDefinitionDialog({
  open,
  onOpenChange,
  entityType,
  field,
  onSubmit,
  isPending,
  selectableEntity = false,
}: FieldDefinitionDialogProps) {
  const { t } = useI18n();
  const ts = t.settings.customFields;
  const isEditing = field !== null && field.id !== '';
  // The object type the field targets. Fixed when editing; user-selectable when
  // creating from the "All" view.
  const [selectedType, setSelectedType] = useState<string>(entityType);
  const showEntityPicker = selectableEntity && !isEditing;

  const form = useForm<FieldFormValues>({
    resolver: zodResolver(fieldSchema),
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      fieldType: 'text',
      required: false,
      group: '',
      options: [],
      config: {},
    },
  });

  const { fields: optionFields, append: appendOption, remove: removeOption } = useFieldArray({
    control: form.control,
    name: 'options',
  });

  const watchFieldType = form.watch('fieldType');
  const watchName = form.watch('name');

  // Auto-generate slug from name when creating
  useEffect(() => {
    if (!isEditing && watchName) {
      form.setValue('slug', slugify(watchName), { shouldValidate: false });
    }
  }, [watchName, isEditing, form]);

  // Reset form when field changes
  useEffect(() => {
    if (open) {
      setSelectedType(field?.entityType ?? entityType);
      if (field) {
        form.reset({
          name: field.name,
          slug: field.slug,
          description: field.description || '',
          fieldType: field.fieldType,
          required: field.required ?? false,
          group: field.group || '',
          options: field.options || [],
          config: (field.config as FieldFormValues['config']) || {},
        });
      } else {
        form.reset({
          name: '',
          slug: '',
          description: '',
          fieldType: 'text',
          required: false,
          group: '',
          options: [],
          config: {},
        });
      }
    }
  }, [open, field, form, entityType]);

  const showOptionsEditor = watchFieldType === 'single_select' || watchFieldType === 'multi_select';
  const showNumberConfig = watchFieldType === 'number';
  const showCurrencyConfig = watchFieldType === 'currency';
  const showRatingConfig = watchFieldType === 'rating';
  const showEntityRefConfig = watchFieldType === 'entity_ref';

  const handleSubmit = form.handleSubmit((data) => {
    const submitData: UpdateCustomFieldData & { slug?: string; entityType?: string } = {
      name: data.name,
      description: data.description || undefined,
      fieldType: data.fieldType,
      required: data.required,
      group: data.group || undefined,
    };

    if (!isEditing) {
      submitData.slug = data.slug;
      submitData.entityType = selectedType;
    }

    if (showOptionsEditor && data.options && data.options.length > 0) {
      submitData.options = data.options;
    }

    if (data.config && Object.keys(data.config).some(k => data.config?.[k as keyof typeof data.config] !== undefined)) {
      submitData.config = data.config as Record<string, unknown>;
    }

    onSubmit(submitData);
  });

  const entityConfig = getEntityTypeConfig(selectedType);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? ts.editDialog : ts.addDialog}
          </DialogTitle>
          {!showEntityPicker && entityConfig && (
            <p className="text-muted-foreground font-normal text-sm">
              {ts.forEntity.replace('{entityType}', entityConfig.label)}
            </p>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 mt-2">
          {/* Object type picker (only when creating from the "All" view) */}
          {showEntityPicker && (
            <div className="space-y-1.5">
              <Label>{t.common.labels.object}</Label>
              <div className="flex items-center gap-2">
                {ENTITY_TYPES.map((et) => {
                  const Icon = et.icon;
                  const active = selectedType === et.value;
                  return (
                    <Button
                      key={et.value}
                      type="button"
                      variant="ghost"
                      onClick={() => setSelectedType(et.value)}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                        active
                          ? 'border-primary bg-primary/5 text-foreground'
                          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {et.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="name">{ts.fieldName}</Label>
            <Input
              id="name"
              {...form.register('name')}
              placeholder={ts.fieldNamePlaceholder}
            />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <Label htmlFor="slug">{ts.fieldSlug}</Label>
            <Input
              id="slug"
              {...form.register('slug')}
              placeholder={ts.fieldSlugPlaceholder}
              disabled={isEditing}
              className={isEditing ? 'opacity-60' : ''}
            />
            {form.formState.errors.slug && (
              <p className="text-xs text-destructive">{form.formState.errors.slug.message}</p>
            )}
            {isEditing && (
              <p className="text-xs text-muted-foreground">{ts.slugImmutable}</p>
            )}
          </div>

          {/* Field Type */}
          <div className="space-y-1.5">
            <Label>{ts.fieldType}</Label>
            <Controller
              control={form.control}
              name="fieldType"
              render={({ field: controllerField }) => {
                const value = controllerField.value || 'text';
                const isKnown = FIELD_TYPES.some((ft) => ft.value === value);
                return (
                  <Select value={value} onValueChange={controllerField.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={ts.selectFieldType} />
                    </SelectTrigger>
                    <SelectContent>
                      {!isKnown && (
                        <SelectItem value={value}>{value}</SelectItem>
                      )}
                      {FIELD_TYPES.map((ft) => (
                        <SelectItem key={ft.value} value={ft.value}>
                          {ft.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              }}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="description">{ts.fieldDescription}</Label>
            <Textarea
              id="description"
              {...form.register('description')}
              placeholder={ts.fieldDescriptionPlaceholder}
              rows={2}
            />
          </div>

          {/* Required toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="required">{ts.required}</Label>
            <Controller
              control={form.control}
              name="required"
              render={({ field: controllerField }) => (
                <Switch
                  id="required"
                  checked={controllerField.value}
                  onCheckedChange={controllerField.onChange}
                />
              )}
            />
          </div>

          {/* Group */}
          <div className="space-y-1.5">
            <Label htmlFor="group">{ts.group}</Label>
            <Input
              id="group"
              {...form.register('group')}
              placeholder={ts.groupPlaceholder}
            />
          </div>

          {/* Options editor for select types */}
          {showOptionsEditor && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{ts.options}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => appendOption({ label: '', value: '', color: '' })}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {ts.addOption}
                </Button>
              </div>
              {optionFields.length === 0 && (
                <p className="text-xs text-muted-foreground">{ts.noOptions}</p>
              )}
              {optionFields.map((optField, index) => (
                <div key={optField.id} className="flex items-start gap-2">
                  <div className="flex-1 space-y-1">
                    <Input
                      {...form.register(`options.${index}.label`)}
                      placeholder={ts.label}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Input
                      {...form.register(`options.${index}.value`)}
                      placeholder={ts.value}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="w-16">
                    <Input
                      {...form.register(`options.${index}.color`)}
                      placeholder={ts.color}
                      className="h-8 text-sm"
                      type="color"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => removeOption(index)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Number config */}
          {showNumberConfig && (
            <div className="space-y-3">
              <Label>{ts.numberConfig}</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{ts.min}</Label>
                  <Input
                    type="number"
                    {...form.register('config.min', { valueAsNumber: true })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{ts.max}</Label>
                  <Input
                    type="number"
                    {...form.register('config.max', { valueAsNumber: true })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{ts.step}</Label>
                  <Input
                    type="number"
                    {...form.register('config.step', { valueAsNumber: true })}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Currency config */}
          {showCurrencyConfig && (
            <div className="space-y-1.5">
              <Label>{ts.currencyCode}</Label>
              <Input
                {...form.register('config.currency')}
                placeholder={ts.currencyCodePlaceholder}
                className="h-8 text-sm"
              />
            </div>
          )}

          {/* Rating config */}
          {showRatingConfig && (
            <div className="space-y-1.5">
              <Label>{ts.maxRating}</Label>
              <Input
                type="number"
                {...form.register('config.maxRating', { valueAsNumber: true })}
                placeholder="5"
                className="h-8 text-sm"
                min={1}
                max={10}
              />
            </div>
          )}

          {/* Entity ref config */}
          {showEntityRefConfig && (
            <div className="space-y-1.5">
              <Label>{ts.targetEntityType}</Label>
              <Input
                {...form.register('config.entityType')}
                placeholder={ts.targetEntityTypePlaceholder}
                className="h-8 text-sm"
              />
            </div>
          )}

          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.actions.cancel}
            </Button>
            <Button type="submit" disabled={isPending || (isEditing && !form.formState.isDirty)}>
              {isPending ? t.settings.actions.saving : isEditing ? ts.updateField : ts.createField}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
