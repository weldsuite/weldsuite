import type { Meta, StoryObj } from '@storybook/react';

import { RadarChart } from '@weldsuite/ui/components/radar-chart';

import { RadarPlayground } from './shape-playgrounds';

const axes = ['Speed', 'Quality', 'Price', 'Support', 'Reach', 'Retention'];

const meta = {
  title: 'Charts/RadarChart',
  component: RadarChart,
  parameters: {
    docs: {
      description: {
        component: 'Scores across several areas on a web: the main series filled, a comparison dashed. Point at an area for every series\' score there.',
      },
    },
  },
  args: {
    axes,
    series: [
      { key: 'now', label: 'This quarter', values: [7.8, 8.4, 6, 9.2, 5.8, 7.4] },
      { key: 'before', label: 'Previous quarter', values: [6.2, 7, 5.5, 8, 5, 6.6], dashed: true },
    ],
    max: 10,
    caption: 'Customer satisfaction',
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: 520 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof RadarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <RadarPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const WithComparison: Story = {
  name: 'With comparison',
};

export const OneSeries: Story = {
  name: 'One series',
  args: { series: [{ key: 'skills', label: 'Team skills', values: [80, 64, 72, 90, 55, 68], color: 'var(--chart-4)' }], max: 100 },
};
