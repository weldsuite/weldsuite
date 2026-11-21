import type { Meta, StoryObj } from '@storybook/react';
import { Boxes, Clock, Package, Percent, TriangleAlert, Users } from 'lucide-react';

import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';

const meta = {
  title: 'Data Display/KpiCard',
  component: KpiCard,
  argTypes: {
    tone: { control: 'select', options: ['default', 'warning', 'danger', 'success'] },
    size: { control: 'inline-radio', options: ['default', 'large'] },
    loading: { control: 'boolean' },
    interactive: { control: 'boolean' },
  },
  args: {
    label: 'Headcount',
    value: 48,
    icon: Users,
  },
  render: (args) => (
    <div className="w-[260px]">
      <KpiCard {...args} />
    </div>
  ),
} satisfies Meta<typeof KpiCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHint: Story = {
  args: { label: 'Clocked in today', value: 31, icon: Clock, hint: 'of 48 employees' },
};

export const Tones: Story = {
  render: () => (
    <KpiGrid className="w-[1000px]">
      <KpiCard label="Products" value="1,204" icon={Package} />
      <KpiCard label="Reply rate" value="12.4%" icon={Percent} tone="success" hint="Last 7 days" />
      <KpiCard label="Low stock" value={7} icon={Boxes} tone="warning" />
      <KpiCard label="Bounce rate" value="6.1%" icon={TriangleAlert} tone="danger" hint="Above the 5% guardrail" />
    </KpiGrid>
  ),
};

/** For a wallboard read from across a room. */
export const Large: Story = {
  args: { label: 'Waiting on the team', value: 12, icon: Clock, size: 'large', tone: 'warning' },
};

export const Loading: Story = {
  args: { loading: true },
};

/** A tile that links somewhere: the app wraps it in its router's link. */
export const Interactive: Story = {
  render: (args) => (
    <a href="#orders" className="block w-[260px] rounded-xl">
      <KpiCard {...args} label="Open orders" value={23} icon={Package} interactive />
    </a>
  ),
};

/**
 * `fit="container"`: columns follow the grid's own width, not the window's,
 * so the same tiles read well in a 400px side panel and on a full page.
 */
export const FitContainer: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {[360, 760].map((width) => (
        <div key={width} style={{ width }} className="rounded-lg border p-3">
          <KpiGrid fit="container">
            <KpiCard label="Revenue" value="€ 48,200" hint="+12.5% vs last month" />
            <KpiCard label="Open tickets" value={23} hint="−3% vs last month" />
            <KpiCard label="Win rate" value="31%" />
            <KpiCard label="Churn" value="2.1%" tone="danger" />
          </KpiGrid>
        </div>
      ))}
    </div>
  ),
};
