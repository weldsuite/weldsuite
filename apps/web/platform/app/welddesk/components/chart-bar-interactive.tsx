
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

export interface HelpdeskChartDataPoint {
  date: string
  conversations: number
  tickets: number
  customers: number
  reviews: number
}

const chartKeys = ["conversations", "tickets", "customers", "reviews"] as const
type ChartKey = (typeof chartKeys)[number]

interface ChartBarInteractiveProps {
  data: HelpdeskChartDataPoint[]
}

export function ChartBarInteractive({ data }: ChartBarInteractiveProps) {
  const { t } = useI18n();
  const td = t.helpdesk.dashboard;
  const chartConfig = {
    views: {
      label: td.activity,
    },
    conversations: {
      label: td.conversations,
      color: "var(--chart-1)",
    },
    tickets: {
      label: t.helpdesk.tickets.title,
      color: "var(--chart-2)",
    },
    customers: {
      label: td.customers,
      color: "var(--chart-3)",
    },
    reviews: {
      label: td.reviews,
      color: "var(--chart-4)",
    },
  } satisfies ChartConfig;
  const [activeChart, setActiveChart] = React.useState<ChartKey>("conversations")

  const total = React.useMemo(
    () => ({
      conversations: data.reduce((acc, curr) => acc + (curr.conversations || 0), 0),
      tickets: data.reduce((acc, curr) => acc + (curr.tickets || 0), 0),
      customers: data.reduce((acc, curr) => acc + (curr.customers || 0), 0),
      reviews: data.reduce((acc, curr) => acc + (curr.reviews || 0), 0),
    }),
    [data]
  )

  const isEmpty = data.length === 0

  return (
    <Card className="py-0">
      <CardHeader className="flex flex-col items-stretch border-b !p-0 sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 sm:!py-0">
          <CardTitle>{td.activity}</CardTitle>
          <CardDescription>
            {isEmpty ? td.noDataAvailable : td.showingActivityLast3Months}
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
            {td.noDataToDisplay}
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
