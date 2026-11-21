import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SectionHeader, ProseBlock } from '@/components/objects/_shared/simple-object-panel';
import { useProductVariants, type CommerceVariant } from '@/hooks/queries/use-commerce-queries';
import { useProductPrices, useSaveProductPrices } from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import {
  entriesFromPrices,
  newPriceEntry,
  sameEntries,
  toPriceInputs,
  validateEntries,
  type PriceEntry,
  type PriceEntryErrors,
} from '../../lib/prices';
import { errorMessage } from '../../lib/text';
import { money } from '../../lib/orders';
import { variantTitle } from '../../lib/variants';

type VariantInfo = Pick<CommerceVariant, 'id' | 'name' | 'sku' | 'optionValues' | 'price' | 'currency'>;

interface EntryRowProps {
  entry: PriceEntry;
  errors: PriceEntryErrors | undefined;
  subject: string;
  canEdit: boolean;
  onChange: (patch: Partial<PriceEntry>) => void;
  onRemove: () => void;
}

/** One price in one currency: the currency, the price and an optional compare-at price. */
function EntryRow({ entry, errors, subject, canEdit, onChange, onRemove }: Readonly<EntryRowProps>) {
  const t = getTranslations('commerce').prices;
  const ids = { currency: `${entry.key}-currency`, price: `${entry.key}-price`, compare: `${entry.key}-compare` };
  const errorFields = [
    { name: 'currency', id: ids.currency },
    { name: 'price', id: ids.price },
    { name: 'compareAtPrice', id: ids.compare },
  ] as const;
  const field = (id: string, error: string | undefined) => ({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined });

  return (
    <li className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
      <div className="space-y-1">
        <label htmlFor={ids.currency} className="sr-only">
          {t.currency} — {subject}
        </label>
        <Input
          {...field(ids.currency, errors?.currency)}
          value={entry.currency}
          onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
          placeholder={t.currencyPlaceholder}
          maxLength={3}
          autoComplete="off"
          spellCheck={false}
          disabled={!canEdit}
          className="uppercase"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.price} className="sr-only">
          {t.price} — {subject}
        </label>
        <Input
          {...field(ids.price, errors?.price)}
          value={entry.price}
          onChange={(event) => onChange({ price: event.target.value })}
          placeholder={t.price}
          inputMode="decimal"
          autoComplete="off"
          disabled={!canEdit}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.compare} className="sr-only">
          {t.compareAt} — {subject}
        </label>
        <Input
          {...field(ids.compare, errors?.compareAtPrice)}
          value={entry.compareAtPrice}
          onChange={(event) => onChange({ compareAtPrice: event.target.value })}
          placeholder={t.compareAt}
          inputMode="decimal"
          autoComplete="off"
          disabled={!canEdit}
        />
      </div>
      {canEdit ? (
        <Button type="button" variant="ghost" size="icon" aria-label={`${t.remove} — ${subject}`} onClick={onRemove}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : (
        <span />
      )}
      {errorFields.map(({ name, id }) => {
        const message = errors?.[name];
        return message ? (
          <p key={name} id={`${id}-error`} className="col-span-full text-xs text-destructive">
            {message}
          </p>
        ) : null;
      })}
    </li>
  );
}

interface GroupProps {
  title: string;
  subtitle: string;
  entries: PriceEntry[];
  errors: Record<string, PriceEntryErrors>;
  canEdit: boolean;
  onChange: (key: string, patch: Partial<PriceEntry>) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
}

/** The base price and the extra currencies of one product or variant. */
function PriceGroup({ title, subtitle, entries, errors, canEdit, onChange, onRemove, onAdd }: Readonly<GroupProps>) {
  const t = getTranslations('commerce').prices;
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </div>
      {entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              errors={errors[entry.key]}
              subject={title}
              canEdit={canEdit}
              onChange={(patch) => onChange(entry.key, patch)}
              onRemove={() => onRemove(entry.key)}
            />
          ))}
        </ul>
      )}
      {canEdit && (
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.addCurrency}
        </Button>
      )}
    </section>
  );
}

/**
 * The Prices tab of the product panel (WeldCommerce): the base price, and the
 * prices in other currencies per product and per variant. Saving replaces the
 * product's whole set (`PUT /products/:id/prices`). Editing needs
 * `products:update`. `variants` is read from the variants cache when not given.
 */
export function ProductPricesSection({
  productId,
  basePrice,
  baseCurrency,
  variants,
  canEdit,
}: Readonly<{
  productId: string;
  basePrice: string | number | null | undefined;
  baseCurrency: string | null | undefined;
  variants?: readonly VariantInfo[];
  canEdit: boolean;
}>) {
  const t = getTranslations('commerce').prices;
  const common = getTranslations('common');
  const prices = useProductPrices(productId);
  const loaded = useProductVariants(productId, variants === undefined);
  const save = useSaveProductPrices();

  const subjects = useMemo<VariantInfo[]>(
    () => [...(variants ?? loaded.data?.data ?? [])].sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '')),
    [variants, loaded.data],
  );
  const serverEntries = useMemo(() => entriesFromPrices(prices.data?.data ?? []), [prices.data]);
  // Null until the member edits something: until then the rows are the server's.
  const [draft, setDraft] = useState<PriceEntry[] | null>(null);
  const [errors, setErrors] = useState<Record<string, PriceEntryErrors>>({});
  const counter = useRef(0);
  const entries = draft ?? serverEntries;
  const dirty = draft !== null && !sameEntries(draft, serverEntries);

  const edit = (update: (list: PriceEntry[]) => PriceEntry[]) => setDraft(update(entries));
  const add = (variantId: string | null) => {
    counter.current += 1;
    edit((list) => [...list, newPriceEntry(`new-${counter.current}`, variantId)]);
  };
  const change = (key: string, patch: Partial<PriceEntry>) =>
    edit((list) => list.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  const remove = (key: string) => {
    edit((list) => list.filter((entry) => entry.key !== key));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)));
  };
  const discard = () => {
    setDraft(null);
    setErrors({});
  };

  const submit = async () => {
    const problems = validateEntries(entries, baseCurrency);
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      toast.error(t.fixErrors);
      return;
    }
    try {
      await save.mutateAsync({ productId, prices: toPriceInputs(entries) });
      toast.success(t.saved);
      discard();
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  if (prices.isLoading) return <InlineSpinner />;
  if (prices.error) return <InlineError className="mx-4 my-3">{t.loadFailed}</InlineError>;

  const forSubject = (variantId: string | null) => entries.filter((entry) => entry.variantId === variantId);
  const baseLabel = basePrice == null || basePrice === '' ? t.noBasePrice : `${t.basePrice}: ${money(basePrice, baseCurrency)}`;

  return (
    <div className="space-y-4 px-4 pb-3">
      <SectionHeader>{t.tab}</SectionHeader>
      <ProseBlock>{t.description}</ProseBlock>

      <PriceGroup
        title={t.thisProduct}
        subtitle={baseLabel}
        entries={forSubject(null)}
        errors={errors}
        canEdit={canEdit}
        onChange={change}
        onRemove={remove}
        onAdd={() => add(null)}
      />

      {subjects.map((variant) => (
        <PriceGroup
          key={variant.id}
          title={variantTitle(variant) ?? variant.sku ?? t.variantFallback}
          subtitle={variant.price ? `${t.basePrice}: ${money(variant.price, variant.currency ?? baseCurrency)}` : t.usesProductPrice}
          entries={forSubject(variant.id)}
          errors={errors}
          canEdit={canEdit}
          onChange={change}
          onRemove={remove}
          onAdd={() => add(variant.id)}
        />
      ))}

      {canEdit && (
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button type="button" variant="outline" size="sm" disabled={!dirty || save.isPending} onClick={discard}>
            {common.actions.cancel}
          </Button>
          <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => void submit()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {common.actions.save}
          </Button>
        </div>
      )}
    </div>
  );
}
