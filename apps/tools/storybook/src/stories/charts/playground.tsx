/**
 * Playgrounds for the charts: a row of settings above the chart to shape the
 * demo data (how many periods, the starting amount, growth, swing, the
 * comparison, losses, nothing booked) and how it draws (card or hero, line,
 * area or bars, colour, width, currency and language). Every change redraws
 * the chart, so it can be shown live.
 *
 * The settings row is a labelled form, not an ARIA toolbar: its sliders and
 * dropdowns use the arrow keys themselves, so each control keeps its own tab
 * stop.
 */

import { useId, useMemo, useState, type ReactNode } from 'react';

import { BreakdownBar, type BreakdownBarItem } from '@weldsuite/ui/components/breakdown-bar';
import { Button } from '@weldsuite/ui/components/button';
import { ComparisonChart, type ComparisonPoint } from '@weldsuite/ui/components/comparison-chart';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Slider } from '@weldsuite/ui/components/slider';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';

export type Option<T extends string> = { value: T; label: string };

export const CURRENCIES: Option<string>[] = [
  { value: 'EUR', label: 'EUR' },
  { value: 'USD', label: 'USD' },
  { value: 'GBP', label: 'GBP' },
];
export const LOCALES: Option<string>[] = [
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'nl-NL', label: 'Nederlands' },
  { value: 'de-DE', label: 'Deutsch' },
];
export const COLORS: Option<string>[] = [
  { value: 'var(--chart-1)', label: 'Blue' },
  { value: 'var(--chart-2)', label: 'Light blue' },
  { value: 'var(--chart-3)', label: 'Amber' },
  { value: 'var(--chart-4)', label: 'Purple' },
  { value: 'var(--chart-5)', label: 'Red' },
];

/* ------------------------------------------------------------------ */
/* The settings row                                                    */
/* ------------------------------------------------------------------ */

/** A row of settings; the last row carries the Reset button. */
export function SettingsBar({ label, onReset, children }: Readonly<{ label: string; onReset?: () => void; children: ReactNode }>) {
  return (
    <form
      aria-label={label}
      className="flex flex-wrap items-end gap-x-5 gap-y-4 border-b bg-background px-6 py-4"
      onSubmit={(event) => event.preventDefault()}
    >
      {children}
      {onReset && (
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onReset}>
          Reset
        </Button>
      )}
    </form>
  );
}

function Setting({ label, htmlFor, children }: Readonly<{ label: string; htmlFor?: string; children: ReactNode }>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function ChoiceSetting<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{ label: string; value: T; options: Option<T>[]; onChange: (value: T) => void }>) {
  return (
    <Setting label={label}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label={label}
        value={value}
        // A single toggle group reports "" when the pressed item is pressed again: keep the choice.
        onValueChange={(next) => next && onChange(next as T)}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} className="px-3">
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Setting>
  );
}

export function SelectSetting({
  label,
  value,
  options,
  onChange,
  width = 'w-32',
}: Readonly<{ label: string; value: string; options: Option<string>[]; onChange: (value: string) => void; width?: string }>) {
  const id = useId();
  return (
    <Setting label={label} htmlFor={id}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} size="sm" className={width}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Setting>
  );
}

export function SliderSetting({
  label,
  value,
  min,
  max,
  step = 1,
  format = String,
  onChange,
}: Readonly<{ label: string; value: number; min: number; max: number; step?: number; format?: (value: number) => string; onChange: (value: number) => void }>) {
  return (
    <Setting label={`${label}: ${format(value)}`}>
      <Slider
        aria-label={label}
        aria-valuetext={format(value)}
        className="h-8 w-36"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
    </Setting>
  );
}

export function SwitchSetting({ label, checked, onChange }: Readonly<{ label: string; checked: boolean; onChange: (checked: boolean) => void }>) {
  const id = useId();
  return (
    <Setting label={label} htmlFor={id}>
      <div className="flex h-8 items-center">
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
    </Setting>
  );
}

export function AmountSetting({ label, value, onChange }: Readonly<{ label: string; value: number; onChange: (value: number) => void }>) {
  const id = useId();
  return (
    <Setting label={label} htmlFor={id}>
      <NumberInput id={id} className="h-8 w-28" min={0} step={1000} value={value} onValueChange={(next) => onChange(next ?? 0)} />
    </Setting>
  );
}

/** The canvas under the settings row, with the chart at the chosen width. */
export function Preview({ width, children }: Readonly<{ width: number; children: ReactNode }>) {
  return (
    <div className="flex justify-center px-6 py-10">
      <div style={{ width }}>{children}</div>
    </div>
  );
}

export function useMoneyFormat(currency: string, locale: string) {
  return useMemo(() => {
    const money = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const compact = new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
    return { money: (value: number) => money.format(value), compact: (value: number) => compact.format(value) };
  }, [currency, locale]);
}

/* ------------------------------------------------------------------ */
/* ComparisonChart                                                     */
/* ------------------------------------------------------------------ */

const LAST_MONTH = { year: 2026, month: 11 };

const monthKey = (offset: number) => {
  const date = new Date(Date.UTC(LAST_MONTH.year, LAST_MONTH.month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));

export interface SeriesSettings {
  periods: number;
  start: number;
  /** Percent per period. */
  growth: number;
  /** Percent up and down around the trend. */
  swing: number;
  comparison: boolean;
  /** The comparison as a percentage of the period it is compared with. */
  compareLevel: number;
  /** Periods that have a figure; the rest are a gap, like a running total that stops at "now". */
  upTo: number;
  runningTotal: boolean;
  losses: boolean;
  nothingBooked: boolean;
}

/** Demo points: `periods` months ending November 2026, each against the same month `periods` earlier. */
export function buildPoints(settings: SeriesSettings): ComparisonPoint[] {
  const { periods, start, growth, swing, comparison, compareLevel, upTo, runningTotal, losses, nothingBooked } = settings;
  const trend = (i: number) => start * (1 + growth / 100) ** i;
  // Losses move everything down by the trend halfway through the period, so about half of it is below zero.
  const shift = losses ? trend(periods * 1.5) : 0;
  const raw = (i: number) => {
    if (nothingBooked) return 0;
    return Math.round(trend(i) * (1 + (swing / 100) * Math.sin(i * 1.9)) - shift);
  };

  let total = 0;
  let compareTotal = 0;
  return Array.from({ length: periods }, (_, i) => {
    total += raw(periods + i);
    compareTotal += Math.round(raw(i) * (compareLevel / 100));
    const value = runningTotal ? total : raw(periods + i);
    const compareValue = runningTotal ? compareTotal : Math.round(raw(i) * (compareLevel / 100));
    return {
      month: monthKey(i - periods + 1),
      value: i < upTo ? value : undefined,
      ...(comparison ? { compareMonth: monthKey(i - 2 * periods + 1), compareValue } : {}),
    };
  });
}

type Variant = 'card' | 'hero';
type Shape = 'line' | 'area' | 'bar';

const COMPARISON_DEFAULTS = {
  variant: 'card' as Variant,
  shape: 'line' as Shape,
  color: 'var(--chart-1)',
  width: 380,
  currency: 'EUR',
  locale: 'en-GB',
  series: {
    periods: 12,
    start: 14_000,
    growth: 3,
    swing: 8,
    comparison: true,
    compareLevel: 100,
    upTo: 12,
    runningTotal: false,
    losses: false,
    nothingBooked: false,
  } satisfies SeriesSettings,
};
const VARIANT_WIDTH: Record<Variant, number> = { card: 380, hero: 720 };

export function ComparisonPlayground() {
  const [variant, setVariant] = useState(COMPARISON_DEFAULTS.variant);
  const [shape, setShape] = useState(COMPARISON_DEFAULTS.shape);
  const [color, setColor] = useState(COMPARISON_DEFAULTS.color);
  const [width, setWidth] = useState(COMPARISON_DEFAULTS.width);
  const [currency, setCurrency] = useState(COMPARISON_DEFAULTS.currency);
  const [locale, setLocale] = useState(COMPARISON_DEFAULTS.locale);
  const [series, setSeries] = useState<SeriesSettings>(COMPARISON_DEFAULTS.series);
  const update = (patch: Partial<SeriesSettings>) => setSeries((current) => ({ ...current, ...patch }));

  const format = useMoneyFormat(currency, locale);
  const dates = useMemo(() => {
    const short = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    const shortYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const long = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return {
      short: (key: string) => short.format(monthDate(key)),
      shortYear: (key: string) => shortYear.format(monthDate(key)),
      long: (key: string) => long.format(monthDate(key)),
    };
  }, [locale]);
  const points = useMemo(() => buildPoints(series), [series]);

  const reset = () => {
    setVariant(COMPARISON_DEFAULTS.variant);
    setShape(COMPARISON_DEFAULTS.shape);
    setColor(COMPARISON_DEFAULTS.color);
    setWidth(COMPARISON_DEFAULTS.width);
    setCurrency(COMPARISON_DEFAULTS.currency);
    setLocale(COMPARISON_DEFAULTS.locale);
    setSeries(COMPARISON_DEFAULTS.series);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SettingsBar label="Chart settings">
        <ChoiceSetting
          label="Variant"
          value={variant}
          options={[
            { value: 'card', label: 'Card' },
            { value: 'hero', label: 'Hero' },
          ]}
          onChange={(next) => {
            setVariant(next);
            setWidth(VARIANT_WIDTH[next]);
          }}
        />
        <ChoiceSetting
          label="Shape"
          value={shape}
          options={[
            { value: 'line', label: 'Line' },
            { value: 'area', label: 'Area' },
            { value: 'bar', label: 'Bars' },
          ]}
          onChange={setShape}
        />
        <SelectSetting label="Colour" value={color} options={COLORS} onChange={setColor} />
        <SliderSetting label="Width" value={width} min={240} max={1040} step={20} format={(v) => `${v}px`} onChange={setWidth} />
        <SelectSetting label="Currency" value={currency} options={CURRENCIES} onChange={setCurrency} width="w-24" />
        <SelectSetting label="Language" value={locale} options={LOCALES} onChange={setLocale} width="w-36" />
      </SettingsBar>
      <SettingsBar label="Demo data" onReset={reset}>
        <SelectSetting
          label="Periods"
          value={String(series.periods)}
          options={[3, 6, 12, 24].map((n) => ({ value: String(n), label: `${n} months` }))}
          onChange={(next) => update({ periods: Number(next), upTo: Number(next) })}
        />
        <AmountSetting label="Starting amount" value={series.start} onChange={(start) => update({ start })} />
        <SliderSetting label="Growth" value={series.growth} min={-10} max={10} step={0.5} format={(v) => `${v}% a month`} onChange={(growth) => update({ growth })} />
        <SliderSetting label="Swing" value={series.swing} min={0} max={60} format={(v) => `±${v}%`} onChange={(swing) => update({ swing })} />
        <SliderSetting
          label="Data up to"
          value={Math.min(series.upTo, series.periods)}
          min={1}
          max={series.periods}
          format={(v) => `${v} of ${series.periods}`}
          onChange={(upTo) => update({ upTo })}
        />
        <SwitchSetting label="Comparison" checked={series.comparison} onChange={(comparison) => update({ comparison })} />
        <SliderSetting
          label="Comparison level"
          value={series.compareLevel}
          min={20}
          max={180}
          step={5}
          format={(v) => `${v}%`}
          onChange={(compareLevel) => update({ compareLevel })}
        />
        <SwitchSetting label="Running total" checked={series.runningTotal} onChange={(runningTotal) => update({ runningTotal })} />
        <SwitchSetting label="Below zero" checked={series.losses} onChange={(losses) => update({ losses })} />
        <SwitchSetting label="Nothing booked" checked={series.nothingBooked} onChange={(nothingBooked) => update({ nothingBooked })} />
      </SettingsBar>
      <Preview width={width}>
        <ComparisonChart
          variant={variant}
          shape={shape}
          color={color}
          label="Revenue"
          compareLabel={variant === 'hero' ? 'Last year' : 'Previous period'}
          points={points}
          formatTick={variant === 'hero' ? dates.short : dates.shortYear}
          formatAxisValue={format.compact}
          formatValue={format.money}
          formatPeriod={dates.long}
          className={variant === 'hero' ? 'aspect-auto h-[200px] w-full' : 'aspect-auto h-[250px] w-full'}
        />
      </Preview>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* BreakdownBar                                                        */
/* ------------------------------------------------------------------ */

const AGING: Array<{ key: string; label: string; color: string }> = [
  { key: 'current', label: 'Not due', color: 'var(--chart-1)' },
  { key: '1-30', label: '1–30 days', color: '#f5b900' },
  { key: '31-60', label: '31–60 days', color: '#ed6704' },
  { key: '61-90', label: '61–90 days', color: '#df1b41' },
  { key: '90+', label: '90+ days', color: '#a3123a' },
];
const ACCOUNTS: Array<{ key: string; label: string; color: string }> = [
  { key: 'business', label: 'Business account', color: 'var(--chart-1)' },
  { key: 'savings', label: 'Savings', color: 'var(--chart-2)' },
  { key: 'card', label: 'Credit card', color: '#00a2b8' },
  { key: 'tax', label: 'Tax reserve', color: '#8d7ffa' },
  { key: 'payroll', label: 'Payroll', color: '#ed6704' },
  { key: 'usd', label: 'USD account', color: 'var(--muted-foreground)' },
];

export interface BreakdownSettings {
  kind: 'aging' | 'accounts';
  items: number;
  total: number;
  /** 0 spreads the total evenly; higher puts more of it on the first items. */
  spread: number;
  negative: boolean;
  nothing: boolean;
}

/** Demo items: `total` shared out over the rows, the first ones getting more as `spread` goes up. */
export function buildItems(settings: BreakdownSettings, money: (value: number) => string): BreakdownBarItem[] {
  const rows = settings.kind === 'aging' ? AGING : ACCOUNTS.slice(0, settings.items);
  const weights = rows.map((_, i) => Math.exp((-settings.spread / 40) * i));
  const sum = weights.reduce((a, b) => a + b, 0);
  return rows.map((row, i) => {
    let amount = settings.nothing ? 0 : Math.round(((settings.total * weights[i]) / sum) * 100) / 100;
    if (settings.negative && i === rows.length - 1) amount = -Math.abs(amount || settings.total * 0.05);
    return { ...row, amount, display: money(amount) };
  });
}

const BREAKDOWN_DEFAULTS = {
  width: 380,
  currency: 'EUR',
  locale: 'en-GB',
  settings: { kind: 'aging', items: 3, total: 12_642, spread: 20, negative: false, nothing: false } satisfies BreakdownSettings,
};

export function BreakdownPlayground() {
  const [width, setWidth] = useState(BREAKDOWN_DEFAULTS.width);
  const [currency, setCurrency] = useState(BREAKDOWN_DEFAULTS.currency);
  const [locale, setLocale] = useState(BREAKDOWN_DEFAULTS.locale);
  const [settings, setSettings] = useState<BreakdownSettings>(BREAKDOWN_DEFAULTS.settings);
  const update = (patch: Partial<BreakdownSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const format = useMoneyFormat(currency, locale);
  const items = useMemo(() => buildItems(settings, format.money), [settings, format]);

  const reset = () => {
    setWidth(BREAKDOWN_DEFAULTS.width);
    setCurrency(BREAKDOWN_DEFAULTS.currency);
    setLocale(BREAKDOWN_DEFAULTS.locale);
    setSettings(BREAKDOWN_DEFAULTS.settings);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SettingsBar label="Demo data" onReset={reset}>
        <ChoiceSetting
          label="Breakdown"
          value={settings.kind}
          options={[
            { value: 'aging', label: 'By age' },
            { value: 'accounts', label: 'Accounts' },
          ]}
          onChange={(kind) => update({ kind })}
        />
        {settings.kind === 'accounts' && (
          <SliderSetting label="Accounts" value={settings.items} min={1} max={ACCOUNTS.length} onChange={(items) => update({ items })} />
        )}
        <AmountSetting label="Total" value={settings.total} onChange={(total) => update({ total })} />
        <SliderSetting label="Spread" value={settings.spread} min={0} max={100} step={5} format={(v) => (v === 0 ? 'even' : `${v}`)} onChange={(spread) => update({ spread })} />
        <SwitchSetting label="Last one negative" checked={settings.negative} onChange={(negative) => update({ negative })} />
        <SwitchSetting label="Nothing outstanding" checked={settings.nothing} onChange={(nothing) => update({ nothing })} />
        <SliderSetting label="Width" value={width} min={240} max={720} step={20} format={(v) => `${v}px`} onChange={setWidth} />
        <SelectSetting label="Currency" value={currency} options={CURRENCIES} onChange={setCurrency} width="w-24" />
        <SelectSetting label="Language" value={locale} options={LOCALES} onChange={setLocale} width="w-36" />
      </SettingsBar>
      <Preview width={width}>
        <BreakdownBar items={items} />
      </Preview>
    </div>
  );
}
