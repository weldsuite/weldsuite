/**
 * Cash on the active bank accounts: the shadcn donut with the total in the
 * middle and every account listed below it with its balance.
 *
 * Balances are in each account's own currency, so only accounts in the
 * entity's base currency add up to the total and get a slice; the list shows
 * every account. A pie cannot draw a negative slice, so an overdrawn account
 * is listed but not drawn.
 */

import { useMemo } from 'react';
import { Label, Pie, PieChart } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useChartFormat } from './use-chart-format';
import { MoneyTooltipRow } from './money-tooltip-row';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export function CashChart({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const format = useChartFormat();
  const base = dashboard.currency;

  const accounts = useMemo(
    () =>
      (dashboard.bankAccounts ?? []).map((account, index) => ({
        ...account,
        balance: Number(account.currentBalance ?? 0),
        inBase: !account.currency || !base || account.currency === base,
        fill: COLORS[index % COLORS.length],
      })),
    [dashboard.bankAccounts, base],
  );
  const slices = accounts.filter((a) => a.inBase && a.balance > 0);
  const total = accounts.filter((a) => a.inBase).reduce((sum, a) => sum + a.balance, 0);
  const config = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, { label: a.name, color: a.fill }])) satisfies ChartConfig,
    [accounts],
  );

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{td.charts.cash}</CardTitle>
        <CardDescription>{td.charts.cashDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td.noBankAccounts}</p>
        ) : (
          <>
            <ChartContainer config={config} className="mx-auto aspect-square h-[180px]">
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(value, _name, item) => (
                        <MoneyTooltipRow
                          label={String(item.payload?.name ?? '')}
                          color={String(item.payload?.fill ?? '')}
                          value={format.formatMoney(Number(value))}
                        />
                      )}
                    />
                  }
                />
                <Pie
                  data={slices.length ? slices : [{ id: 'empty', name: '', balance: 1, fill: 'var(--muted)' }]}
                  dataKey="balance"
                  nameKey="name"
                  innerRadius={56}
                  outerRadius={84}
                  strokeWidth={4}
                  isAnimationActive={slices.length > 0}
                >
                  <Label
                    content={({ viewBox }) => {
                      if (!viewBox || !('cx' in viewBox)) return null;
                      return (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 6} className="fill-foreground text-base font-semibold">
                            {format.compactMoney(total)}
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 14} className="fill-muted-foreground text-xs">
                            {td.charts.total}
                          </tspan>
                        </text>
                      );
                    }}
                  />
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="space-y-2">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: a.inBase ? a.fill : 'var(--muted)' }} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className={`tabular-nums font-medium ${a.balance < 0 ? 'text-destructive' : ''}`}>
                    {format.formatMoney(a.balance, a.currency ?? undefined)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
