import type { Meta, StoryObj } from '@storybook/react';

import { FunnelChart, type FunnelStep } from '@weldsuite/ui/components/funnel-chart';

import { FunnelPlayground } from './analytics-playgrounds';

const step = (label: string, value: number, color?: string): FunnelStep => ({
  key: label,
  label,
  value,
  display: value.toLocaleString('en-GB'),
  color,
});

const meta = {
  title: 'Charts/FunnelChart',
  component: FunnelChart,
  parameters: {
    docs: {
      description: {
        component:
          "A conversion funnel as on dub.co's analytics: a smooth band through the steps with two fainter layers, each step's share of the first in a pill, and a card with the conversion from the step before under the pointer.",
      },
    },
  },
  args: {
    steps: [step('Visitors', 12_400), step('Sign-ups', 3_100), step('Trials', 1_240), step('Customers', 620)],
    conversionLabel: (share: number, previous: FunnelStep) => `${Math.round(share * 100)}% of ${previous.label.toLowerCase()}`,
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div className="w-[720px] overflow-hidden rounded-xl border">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof FunnelChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <FunnelPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const TrialToPaid: Story = {
  name: 'Trial to paid',
};

/** dub.co's own funnel: clicks, leads and sales. */
export const ClicksLeadsSales: Story = {
  name: 'Clicks, leads and sales',
  args: { steps: [step('Clicks', 130), step('Leads', 100, '#8d7ffa'), step('Sales', 24, '#00a2b8')] },
};

export const NoData: Story = {
  name: 'No data',
  args: { steps: [step('Visitors', 0), step('Sign-ups', 0), step('Customers', 0)] },
};
