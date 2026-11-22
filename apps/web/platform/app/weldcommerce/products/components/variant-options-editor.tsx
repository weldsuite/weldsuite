import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
import type { VariantOption } from '@/hooks/queries/use-commerce-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import {
  MAX_COMBINATIONS,
  MAX_OPTIONS,
  cleanOptions,
  combinationCount,
  hasDuplicateNames,
} from '../../lib/variants';
import { fill } from '../../lib/text';

interface DraftOption extends VariantOption {
  /** Stable React key; options have no id of their own. */
  key: number;
  /** What is typed in the option's "add a value" field. */
  pending: string;
  /** Focus its name field when it appears (the first option on open, and each added one). */
  focus?: boolean;
}

const nameId = (key: number) => `variant-option-name-${key}`;
const valueId = (key: number) => `variant-option-value-${key}`;

/**
 * The option matrix behind a product's variants: up to three options, each
 * with its values. "Generate" sends them to `variants/generate`, which makes
 * a variant for every combination and keeps the ones that already exist.
 * A value still typed in a field counts, so Generate never drops it.
 */
export function VariantOptionsEditor({
  initialOptions,
  onGenerate,
  isGenerating,
  onCancel,
}: Readonly<{
  initialOptions: VariantOption[];
  onGenerate: (options: VariantOption[]) => Promise<void> | void;
  isGenerating?: boolean;
  onCancel: () => void;
}>) {
  const t = getTranslations('commerce').variants.options;
  const tc = getTranslations('common');
  const nextKey = useRef(0);
  const addOptionButton = useRef<HTMLButtonElement>(null);
  const draft = (option: VariantOption, focus = false): DraftOption => ({
    ...option,
    key: nextKey.current++,
    pending: '',
    focus,
  });
  // The editor opens in place of the button that opened it: focus starts on the first option.
  const [options, setOptions] = useState<DraftOption[]>(() =>
    initialOptions.length > 0
      ? initialOptions.map((option, index) => draft(option, index === 0))
      : [draft({ name: '', values: [] }, true)],
  );

  const effective = useMemo(
    () => options.map((o) => ({ name: o.name, values: o.pending.trim() ? [...o.values, o.pending] : o.values })),
    [options],
  );
  const cleaned = useMemo(() => cleanOptions(effective), [effective]);
  const count = combinationCount(cleaned);

  let problem: string | null = null;
  if (cleaned.length !== options.length) problem = t.incomplete;
  else if (hasDuplicateNames(cleaned)) problem = t.duplicateNames;
  else if (count > MAX_COMBINATIONS) problem = t.tooMany;

  const change = (key: number, patch: Partial<DraftOption>) =>
    setOptions((prev) => prev.map((o) => (o.key === key ? { ...o, ...patch } : o)));

  const addValue = (option: DraftOption) => {
    const value = option.pending.trim();
    if (!value) return;
    change(option.key, {
      values: option.values.includes(value) ? option.values : [...option.values, value],
      pending: '',
    });
  };

  const onValueKeyDown = (event: KeyboardEvent<HTMLInputElement>, option: DraftOption) => {
    if (event.key !== 'Enter' && event.key !== ',') return;
    // While an IME composes, Enter confirms the candidate and a comma is part of the text: the
    // value isn't finished. Safari clears isComposing before that keydown; keyCode 229 still shows it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    addValue(option);
  };

  const removeValue = (option: DraftOption, value: string) => {
    change(option.key, { values: option.values.filter((v) => v !== value) });
    // The focused button goes with its value: keep focus in this option, on its value field.
    document.getElementById(valueId(option.key))?.focus();
  };

  const removeOption = (index: number) => {
    const removed = options[index];
    const neighbour = options[index - 1] ?? options[index + 1];
    setOptions((prev) => prev.filter((o) => o.key !== removed.key));
    // The focused button goes with its option: hand focus to a neighbour, or to Add option.
    (neighbour ? document.getElementById(nameId(neighbour.key)) : addOptionButton.current)?.focus();
  };

  const atMax = options.length >= MAX_OPTIONS;

  return (
    <div className="mx-4 space-y-4 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{t.hint}</p>

      {options.map((option, index) => (
        <fieldset key={option.key} className="space-y-2">
          {/* The group's name, so the repeated fields and buttons say which option they belong to. */}
          <legend className="sr-only">{option.name || `${t.name} ${index + 1}`}</legend>
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor={nameId(option.key)}>{t.name}</Label>
              <Input
                id={nameId(option.key)}
                autoFocus={option.focus}
                value={option.name}
                placeholder={t.namePlaceholder}
                maxLength={100}
                onChange={(e) => change(option.key, { name: e.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t.removeOption}
              title={t.removeOption}
              onClick={() => removeOption(index)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          {option.values.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {option.values.map((value) => (
                <li key={value}>
                  <Badge variant="secondary" className="gap-1 pr-1">
                    {value}
                    <button
                      type="button"
                      className="rounded-sm hover:bg-muted-foreground/20"
                      aria-label={fill(t.removeValue, { value })}
                      onClick={() => removeValue(option, value)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={valueId(option.key)} className="sr-only">
              {t.values}
            </Label>
            <div className="flex gap-2">
              <Input
                id={valueId(option.key)}
                value={option.pending}
                placeholder={t.valuePlaceholder}
                maxLength={100}
                onChange={(e) => change(option.key, { pending: e.target.value })}
                onKeyDown={(e) => onValueKeyDown(e, option)}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => addValue(option)}>
                {t.addValue}
              </Button>
            </div>
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={addOptionButton}
          type="button"
          variant="outline"
          size="sm"
          disabled={atMax}
          // The new option's name takes focus (this button may turn disabled, which would drop it).
          onClick={() => setOptions((prev) => [...prev, draft({ name: '', values: [] }, true)])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t.addOption}
        </Button>
        {atMax && <span className="text-xs text-muted-foreground">{t.maxOptions}</span>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className={problem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} role="status">
          {problem ?? (count > 0 ? plural(count, t.combinations, getLocale()) : null)}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {tc.actions.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={problem !== null || cleaned.length === 0 || isGenerating}
            onClick={() => void onGenerate(cleaned)}
          >
            {isGenerating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {t.generate}
          </Button>
        </div>
      </div>
    </div>
  );
}
