import type { Meta, StoryObj } from '@storybook/react';

import { PieChart, type PieSlice } from '@weldsuite/ui/components/pie-chart';

import { PiePlayground } from './shape-playgrounds';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const slice = (label: string, value: number): PieSlice => ({ key: label, label, value, display: money.format(value) });
const countries = [slice('Netherlands', 14_450), slice('Belgium', 7_320), slice('Germany', 5_180), slice('France', 2_900), slice('Other', 1_570)];
const expenses = [slice('Payroll', 9_200), slice('Rent', 3_400), slice('Software', 2_600), slice('Marketing', 1_900), slice('Other', 1_540)];

const meta = {
  title: 'Charts/PieChart',
  component: PieChart,
  parameters: {
    docs: {
      description: {
        component:
          'A pie or donut with rows beside it, as in the dashboard\'s breakdown lists. Point at a slice or row to dim the others; on a slice a card shows its share and amount.',
      },
    },
  },
  args: { slices: countries, label: 'Revenue by country' },
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
} satisfies Meta<typeof PieChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <PiePlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Pie: Story = {};

export const Donut: Story = {
  args: { slices: expenses, variant: 'donut', center: { value: money.format(18_640), label: 'total' }, label: 'Expenses by category' },
};

export const DonutPlayground: Story = {
  name: 'Donut playground',
  render: () => <PiePlayground variant="donut" />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const WithoutRows: Story = {
  name: 'Without rows',
  args: { legend: false, size: 200 },
};

export const NoData: Story = {
  name: 'No data',
  args: { slices: countries.map((s) => ({ ...s, value: 0, display: money.format(0) })), variant: 'donut' },
};
