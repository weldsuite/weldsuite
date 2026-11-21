/**
 * Playgrounds for the pie, donut, radial, gauge, radar, treemap, scatter and
 * stacked area charts: the same settings rows as the other chart
 * playgrounds, shaping demo data that redraws the chart on every change.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { Gauge } from '@weldsuite/ui/components/gauge';
import { PieChart, type PieSlice } from '@weldsuite/ui/components/pie-chart';
import { RadarChart, type RadarSeries } from '@weldsuite/ui/components/radar-chart';
import { RadialBars, type RadialBarsItem } from '@weldsuite/ui/components/radial-bars';
import { ScatterChart, type ScatterPoint } from '@weldsuite/ui/components/scatter-chart';
import { StackedAreaChart, type StackedAreaSeries } from '@weldsuite/ui/components/stacked-area-chart';
import { Treemap, type TreemapItem } from '@weldsuite/ui/components/treemap';

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

/** A repeatable -1..1 wobble per index, so the demo data looks real but stays the same. */
const wobble = (i: number, seed = 1) => Math.sin(i * 12.9898 * seed + seed * 78.233);

/** Shares out `total` over `count` parts, the first ones getting more as `spread` (0-100) goes up. */
function shareOut(total: number, count: number, spread: number, seed = 2): number[] {
  const weights = Array.from({ length: count }, (_, i) => Math.exp((-spread / 40) * i) * (0.85 + 0.15 * Math.abs(wobble(i, seed))));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((total * w) / sum));
}

function useFormats(currency: string, locale: string) {
  const money = useMoneyFormat(currency, locale);
  return useMemo(() => {
    const count = new Intl.NumberFormat(locale);
    const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
    return { ...money, count: (v: number) => count.format(v), percent: (v: number) => percent.format(v) };
  }, [money, locale]);
}

function Page({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}

const width = (value: number, onChange: (v: number) => void, max = 1040) => (
  <SliderSetting label="Width" value={value} min={240} max={max} step={20} format={(v) => `${v}px`} onChange={onChange} />
);
const height = (value: number, onChange: (v: number) => void) => (
  <SliderSetting label="Height" value={value} min={160} max={480} step={20} format={(v) => `${v}px`} onChange={onChange} />
);
const money = (currency: string, locale: string, set: (patch: { currency?: string; locale?: string }) => void) => (
  <>
    <SelectSetting label="Currency" value={currency} options={CURRENCIES} onChange={(c) => set({ currency: c })} width="w-24" />
    <SelectSetting label="Language" value={locale} options={LOCALES} onChange={(l) => set({ locale: l })} width="w-36" />
  </>
);

/* ------------------------------------------------------------------ */
/* Pie and donut                                                       */
/* ------------------------------------------------------------------ */

const COUNTRIES = ['Netherlands', 'Belgium', 'Germany', 'France', 'United Kingdom', 'Spain', 'Italy', 'Other'];
const PIE_DEFAULTS = {
  variant: 'pie' as 'pie' | 'donut',
  slices: 5,
  total: 31_420,
  spread: 35,
  center: true,
  legend: true,
  size: 160,
  width: 520,
  currency: 'EUR',
  locale: 'en-GB',
};

export function PiePlayground({ variant = 'pie' }: Readonly<{ variant?: 'pie' | 'donut' }>) {
  const defaults = { ...PIE_DEFAULTS, variant };
  const [s, setS] = useState(defaults);
  const update = (patch: Partial<typeof PIE_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats(s.currency, s.locale);
  const slices = useMemo<PieSlice[]>(
    () => shareOut(s.total, s.slices, s.spread).map((value, i) => ({ key: COUNTRIES[i], label: COUNTRIES[i], value, display: f.money(value) })),
    [s, f],
  );
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(defaults)}>
        <ChoiceSetting
          label="Shape"
          value={s.variant}
          options={[
            { value: 'pie', label: 'Pie' },
            { value: 'donut', label: 'Donut' },
          ]}
          onChange={(v) => update({ variant: v })}
        />
        <SliderSetting label="Slices" value={s.slices} min={1} max={COUNTRIES.length} onChange={(v) => update({ slices: v })} />
        <AmountSetting label="Total" value={s.total} onChange={(v) => update({ total: v })} />
        <SliderSetting label="Spread" value={s.spread} min={0} max={100} step={5} format={(v) => (v === 0 ? 'even' : `${v}`)} onChange={(v) => update({ spread: v })} />
        {s.variant === 'donut' && <SwitchSetting label="Total inside" checked={s.center} onChange={(v) => update({ center: v })} />}
        <SwitchSetting label="Rows" checked={s.legend} onChange={(v) => update({ legend: v })} />
        <SliderSetting label="Size" value={s.size} min={100} max={280} step={10} format={(v) => `${v}px`} onChange={(v) => update({ size: v })} />
        {width(s.width, (v) => update({ width: v }), 800)}
        {money(s.currency, s.locale, update)}
      </SettingsBar>
      <Preview width={s.width}>
        <PieChart
          slices={slices}
          variant={s.variant}
          center={s.center ? { value: f.money(total), label: 'total' } : undefined}
          formatShare={f.percent}
          legend={s.legend}
          size={s.size}
          label="Revenue by country"
        />
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Radial bars                                                         */
/* ------------------------------------------------------------------ */

const GOALS: Array<[string, number]> = [
  ['Revenue', 100_000],
  ['Deals won', 25],
  ['Calls made', 400],
  ['Demos booked', 60],
  ['Renewals', 40],
];
const RADIAL_DEFAULTS = { rings: 3, progress: 65, variation: 25, legend: true, size: 160, width: 480, locale: 'en-GB' };

export function RadialPlayground() {
  const [s, setS] = useState(RADIAL_DEFAULTS);
  const update = (patch: Partial<typeof RADIAL_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats('EUR', s.locale);
  const items = useMemo<RadialBarsItem[]>(
    () =>
      GOALS.slice(0, s.rings).map(([label, max], i) => {
        const value = Math.max(0, Math.round(max * (s.progress / 100 + (s.variation / 100) * wobble(i, 3))));
        return { key: label, label, value, max, display: i === 0 ? f.money(value) : f.count(value) };
      }),
    [s, f],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(RADIAL_DEFAULTS)}>
        <SliderSetting label="Rings" value={s.rings} min={1} max={GOALS.length} onChange={(v) => update({ rings: v })} />
        <SliderSetting label="Progress" value={s.progress} min={0} max={150} step={5} format={(v) => `${v}% on average`} onChange={(v) => update({ progress: v })} />
        <SliderSetting label="Variation" value={s.variation} min={0} max={60} step={5} format={(v) => `±${v}%`} onChange={(v) => update({ variation: v })} />
        <SwitchSetting label="Rows" checked={s.legend} onChange={(v) => update({ legend: v })} />
        <SliderSetting label="Size" value={s.size} min={100} max={280} step={10} format={(v) => `${v}px`} onChange={(v) => update({ size: v })} />
        {width(s.width, (v) => update({ width: v }), 800)}
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(v) => update({ locale: v })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <RadialBars items={items} formatShare={f.percent} legend={s.legend} size={s.size} />
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Gauge                                                               */
/* ------------------------------------------------------------------ */

const GAUGE_DEFAULTS = { used: 72, limit: 100_000, target: true, targetAt: 90, ends: true, color: 'var(--chart-1)', width: 320, currency: 'EUR', locale: 'en-GB' };

export function GaugePlayground() {
  const [s, setS] = useState(GAUGE_DEFAULTS);
  const update = (patch: Partial<typeof GAUGE_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats(s.currency, s.locale);
  const value = Math.round((s.limit * s.used) / 100);

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(GAUGE_DEFAULTS)}>
        <SliderSetting label="Used" value={s.used} min={0} max={150} format={(v) => `${v}%`} onChange={(v) => update({ used: v })} />
        <AmountSetting label="Limit" value={s.limit} onChange={(v) => update({ limit: v })} />
        <SwitchSetting label="Target mark" checked={s.target} onChange={(v) => update({ target: v })} />
        {s.target && <SliderSetting label="Mark at" value={s.targetAt} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => update({ targetAt: v })} />}
        <SwitchSetting label="Name the ends" checked={s.ends} onChange={(v) => update({ ends: v })} />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(v) => update({ color: v })} />
        {width(s.width, (v) => update({ width: v }), 600)}
        {money(s.currency, s.locale, update)}
      </SettingsBar>
      <Preview width={s.width}>
        <Gauge
          label="Budget used"
          value={value}
          max={s.limit}
          target={s.target ? (s.limit * s.targetAt) / 100 : undefined}
          detail={`${f.money(value)} of ${f.money(s.limit)}`}
          formatShare={f.percent}
          minLabel={s.ends ? f.money(0) : undefined}
          maxLabel={s.ends ? f.money(s.limit) : undefined}
          color={s.color}
          className="max-w-none"
        />
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Radar                                                               */
/* ------------------------------------------------------------------ */

const AREAS = ['Speed', 'Quality', 'Price', 'Support', 'Reach', 'Retention', 'Onboarding', 'Docs'];
const RADAR_DEFAULTS = { areas: 6, level: 75, variation: 15, comparison: true, scale: '10' as '10' | '100', color: 'var(--chart-1)', height: 280, width: 520 };

export function RadarPlayground() {
  const [s, setS] = useState(RADAR_DEFAULTS);
  const update = (patch: Partial<typeof RADAR_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const top = Number(s.scale);
  const series = useMemo<RadarSeries[]>(() => {
    const score = (i: number, level: number, seed: number) =>
      Math.round(Math.min(Math.max((level / 100 + (s.variation / 100) * wobble(i, seed)) * top, 0), top) * 10) / 10;
    const now: RadarSeries = { key: 'now', label: 'This quarter', values: AREAS.slice(0, s.areas).map((_, i) => score(i, s.level, 4)), color: s.color };
    const before: RadarSeries = { key: 'before', label: 'Previous quarter', values: AREAS.slice(0, s.areas).map((_, i) => score(i, s.level - 8, 9)), dashed: true };
    return s.comparison ? [now, before] : [now];
  }, [s, top]);

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(RADAR_DEFAULTS)}>
        <SliderSetting label="Areas" value={s.areas} min={3} max={AREAS.length} onChange={(v) => update({ areas: v })} />
        <SliderSetting label="Scores" value={s.level} min={10} max={100} step={5} format={(v) => `${v}% on average`} onChange={(v) => update({ level: v })} />
        <SliderSetting label="Variation" value={s.variation} min={0} max={40} step={5} format={(v) => `±${v}%`} onChange={(v) => update({ variation: v })} />
        <SwitchSetting label="Comparison" checked={s.comparison} onChange={(v) => update({ comparison: v })} />
        <ChoiceSetting
          label="Out of"
          value={s.scale}
          options={[
            { value: '10', label: '10' },
            { value: '100', label: '100' },
          ]}
          onChange={(v) => update({ scale: v })}
        />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(v) => update({ color: v })} />
        {height(s.height, (v) => update({ height: v }))}
        {width(s.width, (v) => update({ width: v }), 900)}
      </SettingsBar>
      <Preview width={s.width}>
        <div style={{ height: s.height }}>
          <RadarChart axes={AREAS.slice(0, s.areas)} series={series} max={top} caption="Customer satisfaction" className="h-full" />
        </div>
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Treemap                                                             */
/* ------------------------------------------------------------------ */

const SUPPLIERS = ['Office Rent BV', 'Cloudly', 'AdNet', 'Printwerk', 'Koffie & Co', 'Telecom NL', 'Legal Partners', 'Fleet Lease', 'Canteen', 'Insure One', 'Courier', 'Other'];
const TREEMAP_DEFAULTS = { parts: 8, total: 48_920, spread: 30, height: 260, width: 640, currency: 'EUR', locale: 'en-GB' };

export function TreemapPlayground() {
  const [s, setS] = useState(TREEMAP_DEFAULTS);
  const update = (patch: Partial<typeof TREEMAP_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats(s.currency, s.locale);
  const items = useMemo<TreemapItem[]>(
    () => shareOut(s.total, s.parts, s.spread, 5).map((value, i) => ({ key: SUPPLIERS[i], label: SUPPLIERS[i], value, display: f.money(value) })),
    [s, f],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(TREEMAP_DEFAULTS)}>
        <SliderSetting label="Parts" value={s.parts} min={1} max={SUPPLIERS.length} onChange={(v) => update({ parts: v })} />
        <AmountSetting label="Total" value={s.total} onChange={(v) => update({ total: v })} />
        <SliderSetting label="Spread" value={s.spread} min={0} max={100} step={5} format={(v) => (v === 0 ? 'even' : `${v}`)} onChange={(v) => update({ spread: v })} />
        {height(s.height, (v) => update({ height: v }))}
        {width(s.width, (v) => update({ width: v }))}
        {money(s.currency, s.locale, update)}
      </SettingsBar>
      <Preview width={s.width}>
        <div style={{ height: s.height }}>
          <Treemap items={items} formatShare={f.percent} label="Expenses by supplier" className="h-full" />
        </div>
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Scatter                                                             */
/* ------------------------------------------------------------------ */

const SCATTER_DEFAULTS = { points: 40, trend: 40, sized: true, color: 'var(--chart-1)', height: 280, width: 640, currency: 'EUR', locale: 'en-GB' };

export function ScatterPlayground() {
  const [s, setS] = useState(SCATTER_DEFAULTS);
  const update = (patch: Partial<typeof SCATTER_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats(s.currency, s.locale);
  const points = useMemo<ScatterPoint[]>(
    () =>
      Array.from({ length: s.points }, (_, i) => {
        const age = Math.round(Math.abs(wobble(i, 7)) * 120);
        // The trend leans value on age: up when positive, down when negative, none at 0.
        const base = 20_000 + (s.trend / 100) * (age - 60) * 250;
        const value = Math.max(500, Math.round(base + wobble(i, 11) * 12_000));
        return { key: `deal-${i}`, label: `Deal ${i + 1}`, x: age, y: value, size: s.sized ? Math.round(Math.abs(wobble(i, 13)) * 100) : undefined };
      }),
    [s],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(SCATTER_DEFAULTS)}>
        <SliderSetting label="Deals" value={s.points} min={3} max={120} onChange={(v) => update({ points: v })} />
        <SliderSetting label="Trend" value={s.trend} min={-100} max={100} step={10} format={(v) => (v === 0 ? 'none' : `${v > 0 ? '+' : ''}${v}`)} onChange={(v) => update({ trend: v })} />
        <SwitchSetting label="Size by probability" checked={s.sized} onChange={(v) => update({ sized: v })} />
        <SelectSetting label="Colour" value={s.color} options={COLORS} onChange={(v) => update({ color: v })} />
        {height(s.height, (v) => update({ height: v }))}
        {width(s.width, (v) => update({ width: v }))}
        {money(s.currency, s.locale, update)}
      </SettingsBar>
      <Preview width={s.width}>
        <div style={{ height: s.height }}>
          <ScatterChart
            points={points}
            xLabel="Age"
            yLabel="Value"
            sizeLabel={s.sized ? 'Probability' : undefined}
            formatX={(v) => `${Math.round(v)} days`}
            formatY={f.compact}
            formatSize={(v) => `${Math.round(v)}%`}
            color={s.color}
            caption="Open deals: value by age"
            className="h-full"
          />
        </div>
      </Preview>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Stacked area                                                        */
/* ------------------------------------------------------------------ */

const CHANNELS = ['Search', 'Direct', 'Social', 'Email', 'Referral'];
const AREA_DEFAULTS = { series: 3, periods: 12, growth: 3, swing: 12, normalize: false, total: true, height: 260, width: 640, locale: 'en-GB' };

const monthKey = (offset: number) => {
  const date = new Date(Date.UTC(2026, 10 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));

export function StackedAreaPlayground() {
  const [s, setS] = useState(AREA_DEFAULTS);
  const update = (patch: Partial<typeof AREA_DEFAULTS>) => setS((c) => ({ ...c, ...patch }));
  const f = useFormats('EUR', s.locale);
  const dates = useMemo(() => {
    const short = new Intl.DateTimeFormat(s.locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const long = new Intl.DateTimeFormat(s.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const compact = new Intl.NumberFormat(s.locale, { notation: 'compact', maximumFractionDigits: 1 });
    return { tick: (k: string) => short.format(monthDate(k)), long: (k: string) => long.format(monthDate(k)), compact: (v: number) => compact.format(v) };
  }, [s.locale]);
  const periods = useMemo(() => Array.from({ length: s.periods }, (_, i) => monthKey(i - s.periods + 1)), [s.periods]);
  const series = useMemo<StackedAreaSeries[]>(
    () =>
      CHANNELS.slice(0, s.series).map((label, c) => ({
        key: label,
        label,
        values: periods.map((_, i) => Math.round((9_000 / (c + 1)) * (1 + s.growth / 100) ** i * (1 + (s.swing / 100) * wobble(i + c * 7, 2)))),
      })),
    [s, periods],
  );

  return (
    <Page>
      <SettingsBar label="Demo data" onReset={() => setS(AREA_DEFAULTS)}>
        <SliderSetting label="Series" value={s.series} min={1} max={CHANNELS.length} onChange={(v) => update({ series: v })} />
        <SliderSetting label="Months" value={s.periods} min={2} max={24} onChange={(v) => update({ periods: v })} />
        <SliderSetting label="Growth" value={s.growth} min={-10} max={10} step={0.5} format={(v) => `${v}% a month`} onChange={(v) => update({ growth: v })} />
        <SliderSetting label="Swing" value={s.swing} min={0} max={50} step={5} format={(v) => `±${v}%`} onChange={(v) => update({ swing: v })} />
        <SwitchSetting label="Shares of total" checked={s.normalize} onChange={(v) => update({ normalize: v })} />
        <SwitchSetting label="Total in card" checked={s.total} onChange={(v) => update({ total: v })} />
        {height(s.height, (v) => update({ height: v }))}
        {width(s.width, (v) => update({ width: v }))}
        <SelectSetting label="Language" value={s.locale} options={LOCALES} onChange={(v) => update({ locale: v })} width="w-36" />
      </SettingsBar>
      <Preview width={s.width}>
        <div style={{ height: s.height }}>
          <StackedAreaChart
            periods={periods}
            series={series}
            normalize={s.normalize}
            formatTick={dates.tick}
            formatPeriod={dates.long}
            formatAxisValue={s.normalize ? f.percent : dates.compact}
            formatValue={s.normalize ? f.percent : f.count}
            totalLabel={s.total ? 'Total' : undefined}
            caption="Visitors by channel"
            className="h-full"
          />
        </div>
      </Preview>
    </Page>
  );
}
