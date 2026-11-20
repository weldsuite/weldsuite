import type { Meta, StoryObj } from '@storybook/react';

import { ComparisonChart } from '@weldsuite/ui/components/comparison-chart';
import { FollowingTooltip } from '@weldsuite/ui/components/following-tooltip';

import { formatters, lastTwelveMonths } from './chart.mocks';

const meta = {
  title: 'Charts/FollowingTooltip',
  component: FollowingTooltip,
  parameters: {
    docs: {
      description: {
        component:
          "A chart tooltip glued to the pointer: 16px beside it, on the side away from the chart's middle, portalled so a narrow card never squeezes it. Spread `FOLLOWING_TOOLTIP_PROPS` on the chart's `<ChartTooltip />` and render the content inside `<FollowingTooltip>`. It needs a Recharts chart around it, so the story hovers a `ComparisonChart`.",
      },
    },
  },
  args: { children: null },
  decorators: [
    (Story) => (
      <div className="w-[380px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FollowingTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Move the pointer over the chart: the tooltip follows it and flips sides halfway. */
export const InAChart: Story = {
  name: 'In a chart',
  render: () => (
    <ComparisonChart
      variant="card"
      label="Revenue"
      compareLabel="Previous period"
      points={lastTwelveMonths(14_000)}
      className="aspect-auto h-[250px] w-full"
      {...formatters}
    />
  ),
};
