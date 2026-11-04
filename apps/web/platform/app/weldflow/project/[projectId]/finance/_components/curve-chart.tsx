/** The S-curve: planned value, earned value and actual cost by week, with the budget, today and the forecast. */

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FinanceSnapshot, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { buildCurve, formatMoney, formatPercent } from '../_lib/finance';
import { useFinanceEnv } from './finance-parts';

const COLORS = { planned: '#a3a3a3', earned: '#2f5fd0', actual: '#ea580c' } as const;

function LegendItem({ color, label, dashed }: Readonly<{ color: string; label: string; dashed?: boolean }>) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="w-4 border-t-2" style={{ borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' }} />
      {label}
    </span>
  );
}

export function CurveChart({
  finance,
  snapshots,
  endDate,
}: Readonly<{ finance: ProjectFinance; snapshots: readonly FinanceSnapshot[]; endDate: string | null }>) {
  const { copy, format, intlLocale } = useFinanceEnv();
  const c = copy.overview.chart;
  const now = useMemo(() => new Date(finance.asOf).getTime(), [finance.asOf]);
  const endMs = endDate ? new Date(endDate).getTime() : null;
  const curve = useMemo(() => buildCurve(snapshots, finance, Number.isFinite(endMs) ? endMs : null, now), [snapshots, finance, endMs, now]);

  const value = (n: number | null | undefined): string =>
    n === null || n === undefined
      ? '–'
      : curve.percent
        ? `${formatPercent(n, intlLocale)}%`
        : formatMoney(String(n), finance.currency, intlLocale);
  const tick = (n: number) => (curve.percent ? `${formatPercent(n, intlLocale)}%` : formatMoney(String(n), finance.currency, intlLocale));
  const date = (t: number) => new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short' }).format(new Date(t));

  const current = curve.points.find((p) => p.t === now);
  const label = format(c.label, { planned: value(current?.planned), earned: value(current?.earned), actual: value(current?.actual) });
  const hasCurve = curve.budget !== null;

  return (
    <section aria-labelledby="finance-curve-title" className="min-w-0 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="finance-curve-title" className="text-sm font-semibold">
          {c.title}
        </h2>
        <span className="text-xs text-muted-foreground">{c.subtitle}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendItem color={COLORS.planned} label={c.planned} />
        <LegendItem color={COLORS.earned} label={c.earned} />
        <LegendItem color={COLORS.actual} label={c.actual} />
        <LegendItem color={COLORS.actual} label={c.forecast} dashed />
      </div>
      {hasCurve ? (
        <div role="img" aria-label={label} className="mt-3 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curve.points} margin={{ left: 8, right: 16, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis
                type="number"
                dataKey="t"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={date}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12 }}
              />
              <YAxis tickFormatter={tick} tick={{ fontSize: 12 }} width={curve.percent ? 48 : 72} tickLine={false} axisLine={false} />
              <Tooltip labelFormatter={(t) => date(Number(t))} formatter={(n) => value(typeof n === 'number' ? n : Number(n))} />
              {curve.budget !== null ? (
                <ReferenceLine
                  y={curve.budget}
                  stroke="currentColor"
                  strokeDasharray="2 4"
                  label={{ value: curve.percent ? c.budgetPercent : format(c.budget, { amount: value(curve.budget) }), position: 'insideTopLeft', fontSize: 12 }}
                />
              ) : null}
              <ReferenceLine x={curve.today} stroke="#c92a2a" strokeWidth={2} label={{ value: c.today, position: 'top', fontSize: 11, fill: '#c92a2a' }} />
              <Line dataKey="planned" name={c.planned} stroke={COLORS.planned} strokeWidth={2} dot={false} connectNulls />
              <Line dataKey="earned" name={c.earned} stroke={COLORS.earned} strokeWidth={2.5} dot={false} connectNulls />
              <Line dataKey="actual" name={c.actual} stroke={COLORS.actual} strokeWidth={2.5} dot={false} connectNulls />
              <Line dataKey="forecast" name={c.forecast} stroke={COLORS.actual} strokeWidth={2} strokeDasharray="6 5" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-6 rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">{c.empty}</p>
      )}
      <div className="mt-3 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))]">
        <Stat label={c.plannedByToday} value={value(current?.planned)} />
        <Stat label={c.done} value={value(current?.earned)} />
        <Stat label={c.spent} value={value(current?.actual)} />
      </div>
    </section>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
