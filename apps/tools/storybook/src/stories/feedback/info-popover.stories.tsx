import type { Meta, StoryObj } from '@storybook/react';

import { InfoPopover } from '@weldsuite/ui/components/info-popover';

const meta = {
  title: 'Feedback/InfoPopover',
  component: InfoPopover,
} satisfies Meta<typeof InfoPopover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <span className="text-sm">Payment terms</span>
      <InfoPopover title="Payment Terms">
        Payment terms determine when invoices are due. Common options include Net 30, Net 60, etc.
      </InfoPopover>
    </div>
  ),
};

export const RichContent: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <span className="text-sm">Account types</span>
      <InfoPopover title="Account Types">
        <ul className="list-disc list-inside space-y-1">
          <li>Asset: Resources owned by the business</li>
          <li>Liability: Debts owed by the business</li>
          <li>Equity: Owner's stake in the business</li>
        </ul>
      </InfoPopover>
    </div>
  ),
};
