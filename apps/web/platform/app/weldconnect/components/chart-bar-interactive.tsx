
import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@weldsuite/ui/components/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@weldsuite/ui/components/chart"
import { useI18n } from "@/lib/i18n/provider"
import { localeConfig } from "@/lib/i18n/locales"
import { Button } from "@weldsuite/ui/components/button"
import { cn } from "@/lib/utils"
import { formatTrendLabel, formatTrendTick, type TrendApiPeriod } from "./chart-utils"

export interface ExecutionTrendDataPoint {
  date: string
  total: number
  success: number
  failure: number
}

const chartKeys = ["total", "success", "failure"] as const
type ChartKey = (typeof chartKeys)[number]

interface ChartBarInteractiveProps {
  data: ExecutionTrendDataPoint[]
  /** Bucket size the data was fetched for; decides how dates are labelled. */
  period: TrendApiPeriod
  /** The period selector. It scopes this chart only, so it lives in the card header. */
  periodControl?: React.ReactNode
}

export function ChartBarInteractive({ data, period, periodControl }: Readonly<ChartBarInteractiveProps>) {
  const { t, language } = useI18n()
  const locale = localeConfig[language].intlLocale
  const [activeChart, setActiveChart] = React.useState<ChartKey>("total")

  const chartConfig = React.useMemo(() => ({
    views: {
      label: t.weldconnect.components.recentActivity.title,
    },
    total: {
      label: t.weldconnect.components.chart.seriesTotal,
      color: "var(--chart-1)",
    },
    success: {
      label: t.weldconnect.components.chart.seriesSuccessful,
      color: "var(--chart-2)",
    },
    failure: {
      label: t.weldconnect.components.chart.seriesFailed,
      color: "var(--chart-3)",
    },
  } satisfies ChartConfig), [t])

  const total = React.useMemo(
    () => ({
      total: data.reduce((acc, curr) => acc + (curr.total || 0), 0),
      success: data.reduce((acc, curr) => acc + (curr.success || 0), 0),
      failure: data.reduce((acc, curr) => acc + (curr.failure || 0), 0),
    }),
    [data]
  )

  const isEmpty = data.length === 0

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="flex flex-col items-stretch border-b !p-0 lg:flex-row">
        <div className="flex flex-1 items-start justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>{t.weldconnect.components.recentActivity.title}</CardTitle>
            <CardDescription>
              {isEmpty ? t.weldconnect.components.chart.noDataAvailable : t.weldconnect.components.chart.showingActivity}
            </CardDescription>
          </div>
          {periodControl}
        </div>
        <div
          role="group"
          aria-label={t.weldconnect.components.chart.seriesGroupLabel}
          className="grid grid-cols-3 border-t lg:flex lg:border-t-0"
        >
          {chartKeys.map((key) => {
            const active = activeChart === key
            return (
              <Button
                key={key}
                variant="ghost"
                aria-pressed={active}
                data-active={active}
                className="data-[active=true]:bg-muted/60 relative z-30 h-auto min-w-0 flex-col items-start justify-center gap-1 rounded-none border-l px-3 py-3 text-left first:border-l-0 sm:px-6 sm:py-4 lg:px-8 lg:py-5"
                onClick={() => setActiveChart(key)}
              >
                <span className="text-muted-foreground text-xs leading-tight">
                  {chartConfig[key].label}
                </span>
                <span className="text-lg leading-none font-bold sm:text-2xl lg:text-3xl">
                  {total[key].toLocaleString(locale)}
                </span>
                <span
                  aria-hidden
                  className={cn("absolute inset-x-0 bottom-0 h-0.5 transition-opacity", active ? "opacity-100" : "opacity-0")}
                  style={{ backgroundColor: chartConfig[key].color }}
                />
              </Button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="px-2 py-4 sm:p-6">
        {isEmpty ? (
          <div className="flex h-[250px] items-center justify-center text-muted-foreground">
            {t.weldconnect.components.chart.noDataToDisplay}
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[250px] w-full"
          >
            <BarChart
              accessibilityLayer
              data={data}
              margin={{
                left: 0,
                right: 12,
              }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={period === "year" ? 8 : 32}
                tickFormatter={(value) => formatTrendTick(String(value), period, locale)}
              />
              <YAxis
                width={32}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="w-[150px]"
                    nameKey="views"
                    labelFormatter={(value) => formatTrendLabel(String(value), period, locale)}
                  />
                }
              />
              {/* Capped width: a single day of data must not become one full-width block */}
              <Bar
                dataKey={activeChart}
                fill={`var(--color-${activeChart})`}
                maxBarSize={56}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
