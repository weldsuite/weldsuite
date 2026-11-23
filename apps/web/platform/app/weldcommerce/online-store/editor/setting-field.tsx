/**
 * One field of a generated settings form, by the setting's type: text,
 * textarea, rich text (Markdown, with its help text), URL, image (an address:
 * WeldDrive has no public-file picker yet), select (radio buttons up to five
 * options, a select above), checkbox, number with its range, colour,
 * category and product pickers from the catalogue, menu and page selects,
 * a WeldForms form id and a video address.
 */

import { useId, useState } from 'react';
import { useFormContext } from 'react-hook-form';
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

export function SettingField({ definition, siteId }: Readonly<{ definition: SettingDefinition; siteId: string }>) {
  const form = useFormContext<SettingValues>();
  const t = getTranslations('commerce').onlineStore.fields;
  const label = pickLabel(definition.label);
  const help = helpText(definition);
  const menus = useStoreMenus(siteId, definition.type === 'menu');
  const pages = useStorePages(siteId, definition.type === 'page');

  return (
    <FormField
      control={form.control}
      name={definition.id}
      render={({ field }) => {
        const description = help ? <FormDescription>{help}</FormDescription> : null;
        switch (definition.type) {
          case 'checkbox':
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
          case 'select':
            if ((definition.options?.length ?? 0) <= MAX_RADIO_OPTIONS) {
              return <RadioChoice definition={definition} value={asString(field.value)} onChange={field.onChange} onBlur={field.onBlur} />;
            }
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
          case 'number':
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
          case 'color':
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
          case 'textarea':
          case 'richtext':
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
                    rows={definition.type === 'richtext' ? 6 : 3}
                    maxLength={definition.maxLength}
                    className={definition.type === 'richtext' ? 'font-mono text-sm' : undefined}
                  />
                </FormControl>
                {description}
                <FormMessage />
              </FormItem>
            );
          case 'url':
          case 'image':
          case 'video':
          case 'form':
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
                    inputMode={definition.type === 'form' ? 'text' : 'url'}
                    placeholder={definition.type === 'form' ? t.formPlaceholder : undefined}
                    className={definition.type === 'form' ? 'font-mono' : undefined}
                    {...identifierProps}
                  />
                </FormControl>
                {definition.type === 'image' && <ImagePreview url={asString(field.value)} />}
                {description}
                <FormMessage />
              </FormItem>
            );
          case 'category':
          case 'product':
            return (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                <FormControl>
                  <CatalogueChoice
                    kind={definition.type}
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
          case 'categories':
          case 'products':
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
          case 'menu':
          case 'page': {
            const value = asString(field.value);
            const choices =
              definition.type === 'menu'
                ? (menus.data?.data ?? []).map((menu) => ({ value: menu.handle, label: menu.title || menu.handle }))
                : (pages.data?.data ?? []).map((page) => ({ value: page.id, label: page.title }));
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
          default:
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
      }}
    />
  );
}
