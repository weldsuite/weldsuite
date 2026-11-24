/**
 * One field of a generated settings form, by the setting's type: text,
 * textarea, rich text (Markdown, with its help text), URL, image (an address:
 * WeldDrive has no public-file picker yet), select (radio buttons up to five
 * options, a select above), checkbox, number with its range, colour,
 * category and product pickers from the catalogue, menu and page selects,
 * a WeldForms form id and a video address.
 */

import { useId, useState, type ReactNode } from 'react';
import { useFormContext, type ControllerRenderProps } from 'react-hook-form';
import type { SettingDefinition, SettingValues } from '@weldsuite/storefront-theme/catalog';
import { Autocomplete } from '@weldsuite/ui/components/autocomplete';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ColorField } from '@weldsuite/ui/components/color-field';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCommerceCategories } from '@/hooks/queries/use-commerce-queries';
import { useStoreMenus, useStorePages } from '@/hooks/queries/use-online-store-queries';
import { useWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';
import { pickLabel } from '../lib/labels';
import { isImageUrl } from '../lib/settings-schema';

/** Radix Select can't hold an empty value; this stands for "none". */
const NONE = '__none__';
/** Most options a select shows as radio buttons. */
const MAX_RADIO_OPTIONS = 5;

const identifierProps = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

function helpText(definition: SettingDefinition): string | undefined {
  if (definition.help) return pickLabel(definition.help);
  const t = getTranslations('commerce').onlineStore.fields;
  if (definition.type === 'richtext') return t.markdownHelp;
  if (definition.type === 'image') return t.imageHint;
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function useCategoryOptions() {
  const categories = useCommerceCategories({ limit: 100 });
  return {
    loading: categories.isPending,
    options: (categories.data?.data ?? []).map((category) => ({
      value: category.id,
      label: category.name,
      description: category.path ?? undefined,
    })),
  };
}

function useProductOptions() {
  const products = useWeldstashProducts({ limit: 100, status: 'active' });
  return {
    loading: products.isPending,
    options: (products.data?.data ?? []).map((product) => ({
      value: product.id,
      label: product.name,
      description: product.sku ?? undefined,
    })),
  };
}

type CatalogueKind = 'category' | 'product';
type CatalogueOptions = ReturnType<typeof useCategoryOptions>;

interface PickerProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

function CatalogueAutocomplete({ kind, source, value, onChange, ...aria }: Readonly<PickerProps & { kind: CatalogueKind; source: CatalogueOptions }>) {
  const t = getTranslations('commerce').onlineStore.fields;
  return (
    <Autocomplete
      {...aria}
      options={source.options}
      loading={source.loading}
      loadingText={t.loading}
      value={value}
      onValueChange={onChange}
      placeholder={t.choose}
      searchPlaceholder={kind === 'category' ? t.searchCategories : t.searchProducts}
      emptyText={kind === 'category' ? t.noCategories : t.noProducts}
    />
  );
}

function CategoryChoice(props: Readonly<PickerProps>) {
  return <CatalogueAutocomplete {...props} kind="category" source={useCategoryOptions()} />;
}

function ProductChoice(props: Readonly<PickerProps>) {
  return <CatalogueAutocomplete {...props} kind="product" source={useProductOptions()} />;
}

/**
 * One category or product, searched among the first hundred of the
 * catalogue. Mounted only for such a setting, so only it loads them.
 */
export function CatalogueChoice({ kind, ...props }: Readonly<PickerProps & { kind: CatalogueKind }>) {
  return kind === 'category' ? <CategoryChoice {...props} /> : <ProductChoice {...props} />;
}

interface MultiPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  id?: string;
}

function CatalogueMultiSelect({ kind, source, ...props }: Readonly<MultiPickerProps & { kind: CatalogueKind; source: CatalogueOptions }>) {
  const t = getTranslations('commerce').onlineStore.fields;
  return (
    <MultiSelect
      {...props}
      options={source.options}
      placeholder={kind === 'category' ? t.chooseCategories : t.chooseProducts}
      searchPlaceholder={kind === 'category' ? t.searchCategories : t.searchProducts}
      emptyText={kind === 'category' ? t.noCategories : t.noProducts}
    />
  );
}

function CategoryChoices(props: Readonly<MultiPickerProps>) {
  return <CatalogueMultiSelect {...props} kind="category" source={useCategoryOptions()} />;
}

function ProductChoices(props: Readonly<MultiPickerProps>) {
  return <CatalogueMultiSelect {...props} kind="product" source={useProductOptions()} />;
}

/** Several categories or products, in the order chosen. */
function CatalogueChoices({ kind, ...props }: Readonly<MultiPickerProps & { kind: CatalogueKind }>) {
  return kind === 'category' ? <CategoryChoices {...props} /> : <ProductChoices {...props} />;
}

/** A select of up to five options as radio buttons, named by the field's label. */
function RadioChoice({
  definition,
  value,
  onChange,
  onBlur,
}: Readonly<{ definition: SettingDefinition; value: string; onChange: (value: string) => void; onBlur: () => void }>) {
  const labelId = useId();
  return (
    <FormItem>
      <FormLabel id={labelId}>{pickLabel(definition.label)}</FormLabel>
      <FormControl>
        <RadioGroup value={value} onValueChange={onChange} onBlur={onBlur} aria-labelledby={labelId} className="gap-2">
          {(definition.options ?? []).map((option) => {
            const optionId = `${labelId}-${option.value}`;
            return (
              <div key={option.value} className="flex items-center gap-2">
                <RadioGroupItem value={option.value} id={optionId} />
                <label htmlFor={optionId} className="text-sm">
                  {pickLabel(option.label)}
                </label>
              </div>
            );
          })}
        </RadioGroup>
      </FormControl>
      {helpText(definition) && <FormDescription>{helpText(definition)}</FormDescription>}
      <FormMessage />
    </FormItem>
  );
}

function ImagePreview({ url }: Readonly<{ url: string }>) {
  const t = getTranslations('commerce').onlineStore.fields;
  const [failed, setFailed] = useState<string | null>(null);
  // Only full addresses can be shown here; a shop path only resolves on the shop's own host.
  if (!url.startsWith('https://') || !isImageUrl(url) || failed === url) return null;
  return (
    <img
      src={url}
      alt={t.imagePreview}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className="max-h-32 w-full rounded-md border bg-muted object-contain"
    />
  );
}

/** What every kind of field is drawn from: the setting, the form's field, its label and help. */
interface FieldParts {
  definition: SettingDefinition;
  field: ControllerRenderProps<SettingValues, string>;
  label: string;
  description: ReactNode;
}

function checkboxField({ field, label, description }: FieldParts) {
  return (
    <FormItem className="flex flex-row items-start gap-2">
      <FormControl>
        <Checkbox checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} onBlur={field.onBlur} />
      </FormControl>
      <div className="grid gap-1">
        <FormLabel className="font-normal leading-snug">{label}</FormLabel>
        {description}
        <FormMessage />
      </div>
    </FormItem>
  );
}

/** Radio buttons up to five options, a select above. */
function selectField({ definition, field, label, description }: FieldParts) {
  if ((definition.options?.length ?? 0) <= MAX_RADIO_OPTIONS) {
    return <RadioChoice definition={definition} value={asString(field.value)} onChange={field.onChange} onBlur={field.onBlur} />;
  }
  const t = getTranslations('commerce').onlineStore.fields;
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <Select value={asString(field.value)} onValueChange={field.onChange}>
        <FormControl>
          <SelectTrigger onBlur={field.onBlur}>
            <SelectValue placeholder={t.choose} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          {(definition.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {pickLabel(option.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description}
      <FormMessage />
    </FormItem>
  );
}

function numberField({ definition, field, label, description }: FieldParts) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <NumberInput
          name={field.name}
          ref={field.ref}
          value={typeof field.value === 'number' ? field.value : undefined}
          onValueChange={field.onChange}
          onBlur={field.onBlur}
          min={definition.min}
          max={definition.max}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

function colorField({ field, label, description }: FieldParts) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <ColorField
          name={field.name}
          ref={field.ref}
          value={asString(field.value)}
          onValueChange={field.onChange}
          onBlur={field.onBlur}
          swatchLabel={label}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

/** A textarea, or rich text (Markdown): taller, in a monospace font. */
function textareaField({ definition, field, label, description }: FieldParts) {
  const richText = definition.type === 'richtext';
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <Textarea
          name={field.name}
          ref={field.ref}
          value={asString(field.value)}
          onChange={field.onChange}
          onBlur={field.onBlur}
          rows={richText ? 6 : 3}
          maxLength={definition.maxLength}
          className={richText ? 'font-mono text-sm' : undefined}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

/** An address (URL, image, video) or a WeldForms form id; an image shows its preview. */
function addressField({ definition, field, label, description }: FieldParts) {
  const t = getTranslations('commerce').onlineStore.fields;
  const formId = definition.type === 'form';
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <Input
          name={field.name}
          ref={field.ref}
          value={asString(field.value)}
          onChange={field.onChange}
          onBlur={field.onBlur}
          inputMode={formId ? 'text' : 'url'}
          placeholder={formId ? t.formPlaceholder : undefined}
          className={formId ? 'font-mono' : undefined}
          {...identifierProps}
        />
      </FormControl>
      {definition.type === 'image' && <ImagePreview url={asString(field.value)} />}
      {description}
      <FormMessage />
    </FormItem>
  );
}

function catalogueField({ field, label, description }: FieldParts, kind: CatalogueKind) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <CatalogueChoice
          kind={kind}
          value={asString(field.value)}
          onChange={(value) => {
            field.onChange(value);
            field.onBlur();
          }}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

function catalogueListField({ definition, field, label, description }: FieldParts) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <CatalogueChoices
          kind={definition.type === 'categories' ? 'category' : 'product'}
          value={asStrings(field.value)}
          onChange={(value) => {
            field.onChange(value);
            field.onBlur();
          }}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

/** A menu or a page of the shop, or none; a value that no longer exists stays shown as missing. */
function referenceField({ definition, field, label, description }: FieldParts, choices: { value: string; label: string }[]) {
  const t = getTranslations('commerce').onlineStore.fields;
  const value = asString(field.value);
  const missing = value !== '' && !choices.some((choice) => choice.value === value);
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <Select value={value || NONE} onValueChange={(next) => field.onChange(next === NONE ? '' : next)}>
        <FormControl>
          <SelectTrigger onBlur={field.onBlur}>
            <SelectValue placeholder={t.choose} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value={NONE}>{t.none}</SelectItem>
          {missing && (
            <SelectItem value={value}>{definition.type === 'menu' ? `${value} (${t.menuMissing})` : t.pageMissing}</SelectItem>
          )}
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description}
      <FormMessage />
    </FormItem>
  );
}

function textField({ definition, field, label, description }: FieldParts) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <Input
          name={field.name}
          ref={field.ref}
          value={asString(field.value)}
          onChange={field.onChange}
          onBlur={field.onBlur}
          maxLength={definition.maxLength}
        />
      </FormControl>
      {description}
      <FormMessage />
    </FormItem>
  );
}

export function SettingField({ definition, siteId }: Readonly<{ definition: SettingDefinition; siteId: string }>) {
  const form = useFormContext<SettingValues>();
  const label = pickLabel(definition.label);
  const help = helpText(definition);
  const menus = useStoreMenus(siteId, definition.type === 'menu');
  const pages = useStorePages(siteId, definition.type === 'page');

  return (
    <FormField
      control={form.control}
      name={definition.id}
      render={({ field }) => {
        const parts: FieldParts = { definition, field, label, description: help ? <FormDescription>{help}</FormDescription> : null };
        switch (definition.type) {
          case 'checkbox':
            return checkboxField(parts);
          case 'select':
            return selectField(parts);
          case 'number':
            return numberField(parts);
          case 'color':
            return colorField(parts);
          case 'textarea':
          case 'richtext':
            return textareaField(parts);
          case 'url':
          case 'image':
          case 'video':
          case 'form':
            return addressField(parts);
          case 'category':
          case 'product':
            return catalogueField(parts, definition.type);
          case 'categories':
          case 'products':
            return catalogueListField(parts);
          case 'menu':
            return referenceField(parts, (menus.data?.data ?? []).map((menu) => ({ value: menu.handle, label: menu.title || menu.handle })));
          case 'page':
            return referenceField(parts, (pages.data?.data ?? []).map((page) => ({ value: page.id, label: page.title })));
          default:
            return textField(parts);
        }
      }}
    />
  );
}
