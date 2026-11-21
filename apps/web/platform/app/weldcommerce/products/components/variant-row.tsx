import { useRef, useState } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { FieldError } from '@weldsuite/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { formatPanelMoney } from '@/components/objects/_shared/simple-object-panel';
import type { CommerceVariant, UpdateVariantInput } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { VARIANT_STATUSES, parsePriceInput, variantTitle } from '../../lib/variants';
import { fill } from '../../lib/text';
import { useReturnFocus } from '../../lib/use-return-focus';
import { StatusBadge, statusLabel } from '../config/product-columns';

/** SKUs and barcodes are codes, not words: no spellcheck, capitals or autocorrect. */
const CODE_INPUT = { spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off' } as const;

/** What changed between the variant and the edit form, as a PATCH body; null when the price is not a price. */
export function variantPatch(
  variant: CommerceVariant,
  values: { sku: string; barcode: string; price: string; status: string },
): UpdateVariantInput | null {
  const price = parsePriceInput(values.price);
  if (price === undefined) return null;
  const patch: UpdateVariantInput = {};
  const sku = values.sku.trim() || null;
  const barcode = values.barcode.trim() || null;
  if (sku !== (variant.sku ?? null)) patch.sku = sku;
  if (barcode !== (variant.barcode ?? null)) patch.barcode = barcode;
  // "10" and "10.00" are the same price; a blank only matches no price of its own.
  const samePrice =
    price === null || variant.price == null ? price === (variant.price ?? null) : Number(price) === Number(variant.price);
  if (!samePrice) patch.price = price;
  if (values.status !== variant.status) patch.status = values.status;
  return patch;
}

/**
 * One variant in the product panel: its options, SKU, barcode, price, status
 * and stock. Editing opens a small form in place; a blank price falls back to
 * the product's.
 */
export function VariantRow({
  variant,
  productPrice,
  currency,
  canEdit,
  isEditing,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}: Readonly<{
  variant: CommerceVariant;
  productPrice: string | number | null | undefined;
  currency: string | null | undefined;
  canEdit: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  /** Resolves true when saved, so the form closes. */
  onSave: (patch: UpdateVariantInput) => Promise<boolean>;
  onDelete: () => void;
}>) {
  const t = getTranslations('commerce').variants;
  const title = variantTitle(variant) ?? t.defaultTitle;
  const money = variant.currency ?? currency;
  const ownPrice = formatPanelMoney(variant.price, money);
  // Every row has these two buttons: the variant's name tells them apart.
  const editLabel = fill(t.edit, { name: title });
  const deleteLabel = fill(t.delete, { name: title });
  // The edit form replaces the Edit button; closing it puts focus back there.
  const editButton = useReturnFocus<HTMLButtonElement>(isEditing);

  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[variant.sku, variant.barcode].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ownPrice ? (
            <span className="text-sm tabular-nums">{ownPrice}</span>
          ) : (
            <span className="text-sm tabular-nums text-muted-foreground" title={t.productPrice}>
              {/* Muted colour and a hover title alone don't say whose price this is. */}
              <span className="sr-only">{t.productPrice} </span>
              {formatPanelMoney(productPrice, money) ?? '—'}
            </span>
          )}
          <StatusBadge status={variant.status} />
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {fill(t.stock, { count: variant.inventoryQuantity ?? 0 })}
          </span>
          {canEdit && !isEditing && (
            <>
              <Button
                ref={editButton}
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={editLabel}
                title={editLabel}
                onClick={onEdit}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={deleteLabel} title={deleteLabel} onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
      {isEditing && <VariantEditForm variant={variant} onCancel={onCancel} onSave={onSave} />}
    </li>
  );
}

function VariantEditForm({
  variant,
  onCancel,
  onSave,
}: Readonly<{
  variant: CommerceVariant;
  onCancel: () => void;
  onSave: (patch: UpdateVariantInput) => Promise<boolean>;
}>) {
  const t = getTranslations('commerce').variants;
  const tc = getTranslations('common');
  const [values, setValues] = useState({
    sku: variant.sku ?? '',
    barcode: variant.barcode ?? '',
    price: variant.price ?? '',
    status: variant.status,
  });
  const [priceInvalid, setPriceInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const priceInput = useRef<HTMLInputElement>(null);
  const statuses: readonly string[] = (VARIANT_STATUSES as readonly string[]).includes(variant.status)
    ? VARIANT_STATUSES
    : [...VARIANT_STATUSES, variant.status];
  const id = (field: string) => `variant-${variant.id}-${field}`;

  const submit = async () => {
    const patch = variantPatch(variant, values);
    if (patch === null) {
      setPriceInvalid(true);
      // The form is noValidate: move focus to the field in error ourselves, so its error is read out.
      priceInput.current?.focus();
      return;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-2 grid gap-3 rounded-md border bg-muted/30 p-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={id('sku')}>{t.fields.sku}</Label>
          {/* The form takes the Edit button's place: focus starts in it. */}
          <Input
            id={id('sku')}
            autoFocus
            value={values.sku}
            maxLength={100}
            {...CODE_INPUT}
            onChange={(e) => setValues({ ...values, sku: e.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id('barcode')}>{t.fields.barcode}</Label>
          <Input
            id={id('barcode')}
            value={values.barcode}
            maxLength={100}
            {...CODE_INPUT}
            onChange={(e) => setValues({ ...values, barcode: e.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id('price')}>{t.fields.price}</Label>
          <Input
            ref={priceInput}
            id={id('price')}
            inputMode="decimal"
            value={values.price}
            placeholder={t.productPrice}
            aria-invalid={priceInvalid || undefined}
            aria-describedby={priceInvalid ? id('price-error') : undefined}
            onChange={(e) => {
              setPriceInvalid(false);
              setValues({ ...values, price: e.target.value });
            }}
          />
          <FieldError id={id('price-error')} className="text-xs">
            {priceInvalid ? t.invalidPrice : null}
          </FieldError>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id('status')}>{t.fields.status}</Label>
          <Select value={values.status} onValueChange={(status) => setValues({ ...values, status })}>
            <SelectTrigger id={id('status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {tc.actions.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {tc.actions.save}
        </Button>
      </div>
    </form>
  );
}
