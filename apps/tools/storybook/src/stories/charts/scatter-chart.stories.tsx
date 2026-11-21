import type { Meta, StoryObj } from '@storybook/react';

import { ScatterChart, type ScatterPoint } from '@weldsuite/ui/components/scatter-chart';

import { ScatterPlayground } from './shape-playgrounds';

const compact = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
/** Repeatable demo deals: value leaning on age, with a probability for the dot size. */
const deals: ScatterPoint[] = Array.from({ length: 36 }, (_, i) => {
  const age = Math.round(Math.abs(Math.sin(i * 3.7)) * 120);
  return { key: `deal-${i}`, label: `Deal ${i + 1}`, x: age, y: Math.round(12_000 + age * 120 + Math.sin(i * 2.1) * 9_000), size: Math.round(Math.abs(Math.cos(i * 1.3)) * 100) };
});

const meta = {
  title: 'Charts/ScatterChart',
  component: ScatterChart,
  parameters: {
    docs: {
      description: {
        component: 'Two measures per item on light grid lines, a third sizing the dots. Point at a dot for its measures.',
      },
    },
  },
  args: {
    points: deals,
    xLabel: 'Age',
    yLabel: 'Value',
    sizeLabel: 'Probability',
    formatX: (v: number) => `${Math.round(v)} days`,
    formatY: (v: number) => compact.format(v),
    formatSize: (v: number) => `${Math.round(v)}%`,
    caption: 'Open deals: value by age',
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: 640 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof ScatterChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <ScatterPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const OpenDeals: Story = {
  name: 'Open deals',
};

export const SameSizeDots: Story = {
  name: 'Same-size dots',
  args: { points: deals.map(({ size: _size, ...point }) => point), sizeLabel: undefined, color: 'var(--chart-4)' },
};
