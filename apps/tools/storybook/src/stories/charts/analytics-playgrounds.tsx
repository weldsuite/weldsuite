/**
 * Playgrounds for the dub.co-style analytics charts (RankedBars, TargetBars,
 * FunnelChart, Heatmap): the same settings rows as the other chart
 * playgrounds, shaping demo data that redraws the chart on every change.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { FunnelChart, type FunnelStep } from '@weldsuite/ui/components/funnel-chart';
import { Heatmap } from '@weldsuite/ui/components/heatmap';
import { RankedBars, type RankedBarsItem } from '@weldsuite/ui/components/ranked-bars';
import { TargetBars, type TargetBarsItem } from '@weldsuite/ui/components/target-bars';

import {
  AmountSetting,
  ChoiceSetting,
  COLORS,
  CURRENCIES,
  LOCALES,
  Preview,
  SelectSetting,
  SettingsBar,
  SliderSetting,
  SwitchSetting,
  useMoneyFormat,
} from './playground';

/** A repeatable 0-1 wobble per index, so the demo data looks real but stays the same. */
const wobble = (i: number, seed = 1) => (Math.sin(i * 12.9898 * seed + seed * 78.233) * 43758.5453) % 1;
const noise = (i: number, seed = 1) => Math.abs(wobble(i, seed));

export const CUSTOMERS = [
  'Acme Holding',
  'Brightline BV',
  'Noorderlicht',
  'Vos & Zonen',
  'Kade Studio',
  'Polder Labs',
  'Delta Werken',
  'Grachtwerk',
  'Molenaar & Co',
  'Tulp Retail',
  'Duinzicht',
  'Haven Logistics',
];

/** A rounded-square initial, the platform's avatar shape. */
export function Initial({ name }: Readonly<{ name: string }>) {
  return (
    <span className="flex size-5 items-center justify-center rounded-[5px] bg-sky-500/15 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
      {name[0]}
    </span>
  );
}

function useCount(locale: string) {
  return useMemo(() => {
    const count = new Intl.NumberFormat(locale);
    return (value: number) => count.format(value);
  }, [locale]);
}

/* ------------------------------------------------------------------ */
/* RankedBars                                                          */
/* ------------------------------------------------------------------ */

const RANKED_DEFAULTS = {
  count: 6,
  total: 66_400,
  spread: 30,
  kind: 'money' as 'money' | 'count',
  icons: true,
  clickable: false,
  limit: false,
  color: 'var(--chart-1)',
  width: 420,
  currency: 'EUR',
  locale: 'en-GB',
};

export function RankedBarsPlayground() {
  const [s, setS] = useState(RANKED_DEFAULTS);
  const update = (patch: Partial<typeof RANKED_DEFAULTS>) => setS((current) => ({ ...current, ...patch }));
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const money = useMoneyFormat(s.currency, s.locale);
  const count = useCount(s.locale);

  const items = useMemo<RankedBarsItem[]>(() => {
    const weights = CUSTOMERS.slice(0, s.count).map((_, i) => Math.exp((-s.spread / 40) * i) * (0.85 + 0.3 * noise(i, 3)));
    const sum = weights.reduce((a, b) => a + b, 0);
    return CUSTOMERS.slice(0, s.count).map((name, i) => {
      const value = Math.round((s.total * weights[i]) / sum);
      return {
        key: name,
        label: s.kind === 'money' ? name : `/pricing/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        value,
        display: s.kind === 'money' ? money.money(value) : count(value),
        icon: s.icons ? <Initial name={name} /> : undefined,
      };
    });
  }, [s, money, count]);

  return (
    <Page>
      <SettingsBar
        label="Demo data"
        onReset={() => {
          setS(RANKED_DEFAULTS);
          setShowAll(false);
          setSelected(null);
        }}
      >
        <ChoiceSetting
          label="Values"
          value={s.kind}
          options={[
            { value: 'money', label: 'Amounts' },
            { value: 'count', label: 'Counts' },
          ]}
          onChange={(kind) => update({ kind })}
        />
        <SliderSetting label="Rows" value={s.count} min={1} max={CUSTOMERS.length} onChange={(value) => update({ count: value })} />
        <AmountSetting label="Total" value={s.total} onChange={(total) => update({ total })} />
        <SliderSetting label="Spread" value={s.spread} min={0} max={100} step={5} format={(v) => (v === 0 ? 'even' : `${v}`)} onChange={(spread) => update({ spread })} />
        <SwitchSetting label="Icons" checked={s.icons} onChange={(icons) => update({ icons })} />
        <SwitchSetting label="Clickable rows" checked={s.clickable} onChange={(clickable) => update({ clickable })} />
        <SwitchSetting
          label="First 5, then View all"
          checked={s.limit}
          onChange={(limit) => {
            update({ limit });
            setShowAll(false);
          }}
        />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(color) => update({ color })} />
        <SliderSetting label="Width" value={s.width} min={240} max={720} step={20} format={(v) => `${v}px`} onChange={(width) => update({ width })} />
        <SelectSetting label="Currency" value={s.currency} options={CURRENCIES} onChange={(currency) => update({ currency })} width="w-24" />
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(locale) => update({ locale })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <RankedBars
          items={items}
          color={s.color}
          label="Top customers"
          limit={s.limit && !showAll ? 5 : undefined}
          onShowAll={() => setShowAll(true)}
          showAllLabel="View all"
          onSelect={s.clickable ? (item) => setSelected(item.label) : undefined}
        />
        {s.clickable && <p className="mt-4 text-center text-xs text-muted-foreground">{selected ? `Selected: ${selected}` : 'Click a row'}</p>}
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* TargetBars                                                          */
/* ------------------------------------------------------------------ */

const BUDGETS: Array<[string, number]> = [
  ['Payroll', 110_000],
  ['Marketing', 40_000],
  ['Software', 22_000],
  ['Travel', 12_000],
  ['Office', 18_000],
  ['Training', 8_000],
];

const TARGET_DEFAULTS = { rows: 4, usage: 80, variation: 35, color: 'var(--chart-1)', width: 420, currency: 'EUR', locale: 'en-GB' };

export function TargetBarsPlayground() {
  const [s, setS] = useState(TARGET_DEFAULTS);
  const update = (patch: Partial<typeof TARGET_DEFAULTS>) => setS((current) => ({ ...current, ...patch }));
  const money = useMoneyFormat(s.currency, s.locale);

  const items = useMemo<TargetBarsItem[]>(
    () =>
      BUDGETS.slice(0, s.rows).map(([label, target], i) => {
        const usage = Math.max(0, s.usage / 100 + (s.variation / 100) * wobble(i, 7));
        const value = Math.round(target * usage);
        return { key: label, label, value, target, display: money.money(value), targetDisplay: money.money(target) };
      }),
    [s, money],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(TARGET_DEFAULTS)}>
        <SliderSetting label="Rows" value={s.rows} min={1} max={BUDGETS.length} onChange={(rows) => update({ rows })} />
        <SliderSetting label="Used" value={s.usage} min={0} max={150} step={5} format={(v) => `${v}% on average`} onChange={(usage) => update({ usage })} />
        <SliderSetting label="Variation" value={s.variation} min={0} max={80} step={5} format={(v) => `±${v}%`} onChange={(variation) => update({ variation })} />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(color) => update({ color })} />
        <SliderSetting label="Width" value={s.width} min={240} max={720} step={20} format={(v) => `${v}px`} onChange={(width) => update({ width })} />
        <SelectSetting label="Currency" value={s.currency} options={CURRENCIES} onChange={(currency) => update({ currency })} width="w-24" />
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(locale) => update({ locale })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <TargetBars items={items} color={s.color} targetLabel={(target) => `of ${target}`} />
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* FunnelChart                                                         */
/* ------------------------------------------------------------------ */

const STEP_NAMES = ['Visitors', 'Sign-ups', 'Trials', 'Customers', 'Upgrades', 'Referrals'];

const FUNNEL_DEFAULTS = {
  steps: 4,
  start: 12_400,
  conversion: 35,
  variation: 20,
  colours: 'steps' as 'steps' | 'one',
  color: 'var(--chart-1)',
  height: 240,
  width: 720,
  locale: 'en-GB',
};

export function FunnelPlayground() {
  const [s, setS] = useState(FUNNEL_DEFAULTS);
  const update = (patch: Partial<typeof FUNNEL_DEFAULTS>) => setS((current) => ({ ...current, ...patch }));
  const count = useCount(s.locale);
  const percent = useMemo(() => {
    const whole = new Intl.NumberFormat(s.locale, { style: 'percent', maximumFractionDigits: 0 });
    const fine = new Intl.NumberFormat(s.locale, { style: 'percent', maximumFractionDigits: 1 });
    return (share: number) => (share > 0 && share < 0.1 ? fine : whole).format(share);
  }, [s.locale]);

  const steps = useMemo<FunnelStep[]>(() => {
    let value = s.start;
    return STEP_NAMES.slice(0, s.steps).map((label, i) => {
      if (i > 0) value = Math.round(value * Math.min(1, Math.max(0, s.conversion / 100 + (s.variation / 100) * wobble(i, 5))));
      return { key: label, label, value, display: count(value), color: s.colours === 'one' ? s.color : undefined };
    });
  }, [s, count]);

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(FUNNEL_DEFAULTS)}>
        <SliderSetting label="Steps" value={s.steps} min={2} max={STEP_NAMES.length} onChange={(value) => update({ steps: value })} />
        <AmountSetting label="First step" value={s.start} onChange={(start) => update({ start })} />
        <SliderSetting label="Conversion" value={s.conversion} min={5} max={95} step={5} format={(v) => `${v}% a step`} onChange={(conversion) => update({ conversion })} />
        <SliderSetting label="Variation" value={s.variation} min={0} max={50} step={5} format={(v) => `±${v}%`} onChange={(variation) => update({ variation })} />
        <ChoiceSetting
          label="Colours"
          value={s.colours}
          options={[
            { value: 'steps', label: 'Per step' },
            { value: 'one', label: 'One' },
          ]}
          onChange={(colours) => update({ colours })}
        />
        {s.colours === 'one' && <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(color) => update({ color })} />}
        <SliderSetting label="Height" value={s.height} min={160} max={420} step={20} format={(v) => `${v}px`} onChange={(height) => update({ height })} />
        <SliderSetting label="Width" value={s.width} min={320} max={1040} step={20} format={(v) => `${v}px`} onChange={(width) => update({ width })} />
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(locale) => update({ locale })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <div className="overflow-hidden rounded-xl border" style={{ height: s.height }}>
          <FunnelChart
            steps={steps}
            formatPercent={percent}
            conversionLabel={(share, previous) => `${percent(share)} of ${previous.label.toLowerCase()}`}
            className="h-full"
          />
        </div>
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Heatmap                                                             */
/* ------------------------------------------------------------------ */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Pattern = 'office' | 'evenings' | 'weekends' | 'random';
const PATTERNS = [
  { value: 'office', label: 'Office hours' },
  { value: 'evenings', label: 'Evenings' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'random', label: 'Random' },
];

/** How busy an hour of a day is, 0-1, for a pattern. */
function busyness(pattern: Pattern, day: number, hour: number): number {
  const weekday = day < 5;
  const jitter = 0.15 * noise(day * 24 + hour, 11);
  const night = hour < 6 ? 0.25 : 1;
  switch (pattern) {
    case 'office':
      return ((hour >= 8 && hour <= 18 ? 0.75 : 0.08) * (weekday ? 1 : 0.25) + jitter) * night;
    case 'evenings':
      return ((hour >= 18 && hour <= 23 ? 0.8 : 0.12) * (day >= 4 ? 1.2 : 0.8) + jitter) * night;
    case 'weekends':
      return ((weekday ? 0.15 : 0.8) * (hour >= 9 && hour <= 21 ? 1 : 0.3) + jitter) * night;
    default:
      return noise(day * 24 + hour, 3);
  }
}

const HEATMAP_DEFAULTS = {
  pattern: 'office' as Pattern,
  busiest: 42,
  blocks: '24' as '24' | '12',
  color: 'var(--chart-1)',
  legend: true,
  width: 720,
  locale: 'en-GB',
};

export function HeatmapPlayground() {
  const [s, setS] = useState(HEATMAP_DEFAULTS);
  const update = (patch: Partial<typeof HEATMAP_DEFAULTS>) => setS((current) => ({ ...current, ...patch }));
  const count = useCount(s.locale);
  const step = s.blocks === '24' ? 1 : 2;
  const columns = useMemo(() => Array.from({ length: 24 / step }, (_, i) => `${String(i * step).padStart(2, '0')}:00`), [step]);
  const values = useMemo(
    () =>
      DAYS.map((_, day) =>
        columns.map((__, c) => {
          let sum = 0;
          for (let h = c * step; h < (c + 1) * step; h++) sum += busyness(s.pattern, day, h);
          return Math.round((Math.min(sum / step, 1) * s.busiest));
        }),
      ),
    [s.pattern, s.busiest, columns, step],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(HEATMAP_DEFAULTS)}>
        <SelectSetting label="Pattern" value={s.pattern} options={PATTERNS} onChange={(pattern) => update({ pattern: pattern as Pattern })} width="w-36" />
        <AmountSetting label="Busiest hour" value={s.busiest} onChange={(busiest) => update({ busiest })} />
        <ChoiceSetting
          label="Columns"
          value={s.blocks}
          options={[
            { value: '24', label: 'Hours' },
            { value: '12', label: '2 hours' },
          ]}
          onChange={(blocks) => update({ blocks })}
        />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(color) => update({ color })} />
        <SwitchSetting label="Key" checked={s.legend} onChange={(legend) => update({ legend })} />
        <SliderSetting label="Width" value={s.width} min={320} max={1040} step={20} format={(v) => `${v}px`} onChange={(width) => update({ width })} />
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(locale) => update({ locale })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <Heatmap
          rows={DAYS}
          columns={columns}
          values={values}
          color={s.color}
          formatValue={count}
          valueLabel="Tickets"
          cellTitle={(day, hour) => `${day} ${hour}`}
          legend={s.legend ? { less: 'Less', more: 'More' } : undefined}
          caption="Tickets by weekday and hour"
        />
      </Preview>
    </Page>
  );
}

function Page({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}
