import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';

import { RankedBars, type RankedBarsItem } from '@weldsuite/ui/components/ranked-bars';

import { CUSTOMERS, Initial, RankedBarsPlayground } from './analytics-playgrounds';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const amounts = [21_400, 14_800, 11_200, 8_600, 6_300, 4_100, 3_200, 2_400];

const customers: RankedBarsItem[] = amounts.map((value, i) => ({
  key: CUSTOMERS[i],
  label: CUSTOMERS[i],
  value,
  display: money.format(value),
  icon: <Initial name={CUSTOMERS[i]} />,
}));

const pages: RankedBarsItem[] = [
  ['/pricing', 4_812],
  ['/', 3_920],
  ['/features/crm', 2_204],
  ['/blog/invoicing-tips', 1_310],
  ['/contact', 640],
].map(([label, value]) => ({ key: String(label), label: String(label), value: Number(value), display: Number(value).toLocaleString('en-GB') }));

const meta = {
  title: 'Charts/RankedBars',
  component: RankedBars,
  parameters: {
    docs: {
      description: {
        component:
          "A ranked list as on dub.co's analytics: the bar is a light tint behind each row, sized against the biggest. Hover a row for its share of the total.",
      },
    },
  },
  args: { items: customers.slice(0, 6), label: 'Top customers' },
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
} satisfies Meta<typeof RankedBars>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <RankedBarsPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Customers: Story = {};

export const Pages: Story = {
  args: { items: pages, color: 'var(--chart-2)', label: 'Top pages' },
};

export const ClickableRows: Story = {
  name: 'Clickable rows',
  args: { onSelect: fn() },
};

export const ViewAll: Story = {
  name: 'View all',
  args: { items: customers, limit: 5, onShowAll: fn(), showAllLabel: 'View all' },
};
