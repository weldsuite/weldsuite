import type { Meta, StoryObj } from '@storybook/react';

import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';

const meta = {
  title: 'Charts/ChartHoverCard',
  component: ChartHoverCard,
  parameters: {
    docs: {
      description: {
        component: "The card a chart shows for what is under the pointer, as on dub.co's analytics: a title with its rows right under it.",
      },
    },
  },
  args: {
    title: 'Trials',
    children: <ChartTooltipRow swatch="square" color="#00a2b8" label="40% of sign-ups" value="1,240" />,
  },
} satisfies Meta<typeof ChartHoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FunnelStep: Story = {
  name: 'Funnel step',
};

export const HeatmapCell: Story = {
  name: 'Heatmap cell',
  args: { title: 'Tue 14:00', children: <ChartTooltipRow swatch="square" color="var(--chart-1)" label="Tickets" value="38" /> },
};

export const SeveralRows: Story = {
  name: 'Several rows',
  args: {
    title: 'October 2026',
    children: (
      <>
        <ChartTooltipRow label="Revenue" value="€18,240.00" color="var(--chart-1)" />
        <ChartTooltipRow label="Last year" value="€15,610.00" color="var(--muted-foreground)" dashed />
      </>
    ),
  },
};
