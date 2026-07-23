
import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"

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
import { Button } from "@weldsuite/ui/components/button"

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
}

export function ChartBarInteractive({ data }: ChartBarInteractiveProps) {
  const { t } = useI18n()
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
    <Card className="py-0">
      <CardHeader className="flex flex-col items-stretch border-b !p-0 sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 sm:!py-0">
          <CardTitle>{t.weldconnect.components.recentActivity.title}</CardTitle>
          <CardDescription>
            {isEmpty ? t.weldconnect.components.chart.noDataAvailable : t.weldconnect.components.chart.showingActivity}
          </CardDescription>
        </div>
        <div className="flex">
          {chartKeys.map((key) => {
            return (
              <Button
                key={key}
                variant="ghost"
                data-active={activeChart === key}
                className="data-[active=true]:bg-muted/50 relative z-30 flex flex-1 flex-col justify-center gap-1 border-t px-3 py-3 text-left even:border-l sm:border-t-0 sm:border-l sm:px-8 sm:py-6"
                onClick={() => setActiveChart(key)}
              >
                <span className="text-muted-foreground text-[10px] sm:text-xs truncate">
                  {chartConfig[key].label}
                </span>
                <span className="text-base leading-none font-bold sm:text-3xl">
                  {total[key].toLocaleString('en-US')}
                </span>
              </Button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:p-6">
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
                left: 12,
                right: 12,
              }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value) => {
                  const date = new Date(value)
                  return date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="w-[150px]"
                    nameKey="views"
                    labelFormatter={(value) => {
                      return new Date(value).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    }}
                  />
                }
              />
              <Bar dataKey={activeChart} fill={`var(--color-${activeChart})`} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
