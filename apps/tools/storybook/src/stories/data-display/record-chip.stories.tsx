import type { Meta, StoryObj } from '@storybook/react';
import { Banknote, BookText, FileText, User } from 'lucide-react';

import { RecordChip } from '@weldsuite/ui/components/record-chip';

const meta = {
  title: 'Data Display/RecordChip',
  component: RecordChip,
  argTypes: {
    tone: { control: 'select', options: [undefined, 'neutral', 'success', 'warning', 'danger', 'info'] },
    onOpen: { action: 'opened' },
  },
  args: { label: 'INV-2026-0042', href: '#invoice:inv_1' },
} satisfies Meta<typeof RecordChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A real link: a plain click calls `onOpen`, Cmd/Ctrl/middle-click opens `href` in a new tab. */
export const Default: Story = { args: { icon: FileText } };

export const WithSecondaryAndStatus: Story = {
  args: { icon: FileText, secondary: '€ 1.210,00', tone: 'success', statusLabel: 'Paid' },
};

export const Tones: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      <RecordChip {...args} label="Draft" tone="neutral" statusLabel="Draft" />
      <RecordChip {...args} label="Sent" tone="info" statusLabel="Sent" />
      <RecordChip {...args} label="Paid" tone="success" statusLabel="Paid" />
      <RecordChip {...args} label="Overdue" tone="warning" statusLabel="Overdue" />
      <RecordChip {...args} label="Void" tone="danger" statusLabel="Void" />
    </div>
  ),
};

export const Kinds: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      <RecordChip {...args} icon={User} label="Acme Industries" />
      <RecordChip {...args} icon={BookText} label="JE-000123" />
      <RecordChip {...args} icon={Banknote} label="Bank line" secondary="12 Mar" />
    </div>
  ),
};

/** Long labels truncate; the full text stays in the DOM and the tooltip. */
export const LongLabel: Story = {
  args: { icon: User, label: 'Very Long Customer Name Holding International B.V. Amsterdam Branch' },
  render: (args) => (
    <div className="w-56">
      <RecordChip {...args} />
    </div>
  ),
};

/** Without an href it renders a button. */
export const WithoutHref: Story = { args: { href: undefined, label: 'Acme Industries', icon: User } };

/** The chip stops the click, so the row's own handler does not fire. */
export const InsideClickableRow: Story = {
  render: (args) => (
    <div
      role="presentation"
      className="flex w-80 cursor-pointer items-center justify-between rounded border p-3"
      onClick={() => alert('Row clicked')}
    >
      <span className="text-sm">Row</span>
      <RecordChip {...args} />
    </div>
  ),
};
