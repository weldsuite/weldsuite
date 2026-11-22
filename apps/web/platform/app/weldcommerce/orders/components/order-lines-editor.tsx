/**
 * The lines of an order: what is sold, how many, at what price. Products come
 * from the catalogue picker; a free line is a description and a price typed in.
 * Prices the server worked out (the quote) show as the placeholder of a blank
 * price and as each line's total, with its problem in words.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { Button } from '@weldsuite/ui/components/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import type { OrderQuote } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '../../lib/text';
import { money } from '../../lib/orders';
import type { LineValues, OrderFormValues } from '../../lib/order-form';
import { OrderLinePickerDialog } from './order-line-picker-dialog';

export interface QuotedLine {
  unitPrice: string;
  total: string;
  problem: string | null;
}

/** The quote's lines by form line index, through the indexes the request kept. */
export function quotedLinesByIndex(quote: OrderQuote | undefined, lineIndexes: number[]): Map<number, QuotedLine> {
  const byIndex = new Map<number, QuotedLine>();
  quote?.lines.forEach((line, position) => {
    const index = lineIndexes[position];
    if (index !== undefined) byIndex.set(index, line);
  });
  return byIndex;
}

function lineTitle(line: LineValues): string {
  const base = line.name.trim() || getTranslations('commerce').orders.lines.freeLine;
  return line.variantName ? `${base} · ${line.variantName}` : base;
}

function problemText(problem: string): string {
  const t = getTranslations('commerce').orders.lines;
  const known: Record<string, string> = t.problems;
  return known[problem] ?? t.problemUnknown;
}

function LineRow({
  index,
  line,
  quoted,
  currency,
  disabled,
  onRemove,
}: Readonly<{
  index: number;
  line: LineValues;
  quoted: QuotedLine | undefined;
  currency: string;
  disabled: boolean;
  onRemove: () => void;
}>) {
  const t = getTranslations('commerce').orders.lines;
  const form = useFormContext<OrderFormValues>();
  const isFree = line.productId === null && line.variantId === null;
  const title = lineTitle(line);

  return (
    <li className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_7rem_auto] sm:items-start">
      {isFree ? (
        <FormField
          control={form.control}
          name={`items.${index}.name`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.description}</FormLabel>
              <FormControl>
                <Input {...field} maxLength={500} disabled={disabled} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : (
        <div className="min-w-0 pt-1 sm:pt-6">
          <p className="truncate text-sm font-medium">{title}</p>
          {line.sku && <p className="truncate text-xs text-muted-foreground">{line.sku}</p>}
        </div>
      )}

      <FormField
        control={form.control}
        name={`items.${index}.quantity`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.quantity}</FormLabel>
            <FormControl>
              <NumberInput
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                min={1}
                max={100000}
                disabled={disabled}
                value={field.value}
                // Blank is NaN, not undefined: react-hook-form puts an undefined value back to its default.
                onValueChange={(value) => field.onChange(value ?? Number.NaN)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`items.${index}.unitPrice`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.unitPrice}</FormLabel>
            <FormControl>
              <Input
                {...field}
                inputMode="decimal"
                autoComplete="off"
                disabled={disabled}
                placeholder={quoted && !isFree ? quoted.unitPrice : undefined}
                title={isFree ? undefined : t.catalogPrice}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="pt-1 sm:pt-6 sm:text-right">
        <span className="sr-only">{t.lineTotal}: </span>
        <span className="text-sm font-medium tabular-nums">{quoted ? money(quoted.total, currency) : '—'}</span>
      </div>

      {!disabled && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="sm:mt-5"
          aria-label={fill(t.remove, { name: title })}
          title={fill(t.remove, { name: title })}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}

      {quoted?.problem && (
        <p role="alert" className="text-xs text-destructive sm:col-span-full">
          {problemText(quoted.problem)}
        </p>
      )}
    </li>
  );
}

export function OrderLinesEditor({
  quoted,
  currency,
  disabled,
}: Readonly<{ quoted: Map<number, QuotedLine>; currency: string; disabled: boolean }>) {
  const t = getTranslations('commerce').orders.lines;
  const form = useFormContext<OrderFormValues>();
  const { fields, append, remove, update } = useFieldArray({ control: form.control, name: 'items' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootError = form.formState.errors.items?.root?.message ?? form.formState.errors.items?.message;

  // Picking what is already on the order adds to its quantity instead of a second line.
  const addLine = (line: LineValues) => {
    const items = form.getValues('items');
    const index = items.findIndex(
      (item) => !item.itemId && item.productId === line.productId && item.variantId === line.variantId && item.productId !== null,
    );
    if (index >= 0) update(index, { ...items[index], quantity: items[index].quantity + 1 });
    else append(line);
  };

  return (
    <div className="grid gap-3">
      {fields.length === 0 ? (
        <EmptyText>{t.empty}</EmptyText>
      ) : (
        <ul className="grid gap-2">
          {fields.map((field, index) => (
            <LineRow
              key={field.id}
              index={index}
              line={form.watch(`items.${index}`) ?? field}
              quoted={quoted.get(index)}
              currency={currency}
              disabled={disabled}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}
      {rootError && (
        <p role="alert" className="text-sm text-destructive">
          {rootError}
        </p>
      )}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" data-add-line onClick={() => setPickerOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t.addProduct}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              append({ productId: null, variantId: null, sku: null, name: '', variantName: null, quantity: 1, unitPrice: '' })
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t.addFreeLine}
          </Button>
        </div>
      )}
      {pickerOpen && <OrderLinePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={addLine} />}
    </div>
  );
}
