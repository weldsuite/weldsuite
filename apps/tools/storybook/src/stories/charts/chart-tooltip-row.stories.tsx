import type { Meta, StoryObj } from '@storybook/react';

import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';

const meta = {
  title: 'Charts/ChartTooltipRow',
  component: ChartTooltipRow,
  parameters: {
    docs: {
      description: {
        component: "One series in a chart tooltip: a swatch in the series' colour (dashed for a comparison), its label and the value.",
      },
    },
  },
  args: {
    label: 'October 2026',
    value: '€18,240.00',
    color: 'var(--chart-1)',
  },
  // The box the chart's tooltip draws around its rows.
  decorators: [
    (Story) => (
      <div className="grid min-w-[12rem] gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartTooltipRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Period: Story = {};

export const Comparison: Story = {
  args: { label: 'October 2025', value: '€15,610.00', color: 'var(--muted-foreground)', dashed: true },
};

/** A square swatch, for bars, funnel steps and heatmap cells. */
export const Square: Story = {
  args: { label: 'Trials', value: '1,240', color: '#00a2b8', swatch: 'square' },
};

/** How the chart's tooltip lists a period and its comparison. */
export const BothSeries: Story = {
  name: 'Period and comparison',
  render: () => (
    <>
      <ChartTooltipRow label="October 2026" value="€18,240.00" color="var(--chart-1)" />
      <ChartTooltipRow label="October 2025" value="€15,610.00" color="var(--muted-foreground)" dashed />
    </>
  ),
};
