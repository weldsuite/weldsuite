import type { Meta, StoryObj } from '@storybook/react';

import { TargetBars, type TargetBarsItem } from '@weldsuite/ui/components/target-bars';

import { TargetBarsPlayground } from './analytics-playgrounds';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const budget = (label: string, value: number, target: number): TargetBarsItem => ({
  key: label,
  label,
  value,
  target,
  display: money.format(value),
  targetDisplay: money.format(target),
});

const meta = {
  title: 'Charts/TargetBars',
  component: TargetBars,
  parameters: {
    docs: {
      description: {
        component:
          'Amounts against their targets, drawn like dub.co\'s usage bars: a rounded track filled to the share of the target, red once over it. Each bar is an ARIA meter.',
      },
    },
  },
  args: {
    items: [budget('Payroll', 92_400, 110_000), budget('Marketing', 31_800, 40_000), budget('Software', 24_700, 22_000), budget('Travel', 3_900, 12_000)],
    targetLabel: (target: string) => `of ${target}`,
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div className="w-[420px]">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof TargetBars>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <TargetBarsPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Budgets: Story = {};

export const Goals: Story = {
  args: {
    items: [
      { key: 'deals', label: 'Deals won', value: 18, target: 25, display: '18', targetDisplay: '25' },
      { key: 'demos', label: 'Demos booked', value: 64, target: 60, display: '64', targetDisplay: '60' },
      { key: 'calls', label: 'Calls made', value: 212, target: 400, display: '212', targetDisplay: '400' },
    ],
    color: 'var(--chart-4)',
  },
};

export const NothingSpent: Story = {
  name: 'Nothing spent',
  args: { items: [budget('Payroll', 0, 110_000), budget('Marketing', 0, 40_000)] },
};
