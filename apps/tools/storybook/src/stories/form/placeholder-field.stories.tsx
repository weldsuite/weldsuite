import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { PlaceholderField } from '@weldsuite/ui/components/placeholder-field';

const PLACEHOLDERS = [
  { key: 'customerName', label: 'Customer name' },
  { key: 'number', label: 'Invoice number' },
  { key: 'amount', label: 'Amount' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'link', label: 'Online link' },
];

const meta = {
  title: 'Form/PlaceholderField',
  component: PlaceholderField,
  args: {
    value: '',
    onChange: () => {},
    placeholders: PLACEHOLDERS,
    insertLabel: 'Insert',
    chipsLabel: 'Placeholders',
  },
} satisfies Meta<typeof PlaceholderField>;

export default meta;
type Story = StoryObj<typeof meta>;

function BodyExample(args: React.ComponentProps<typeof PlaceholderField>) {
  const [value, setValue] = useState('Dear {customerName},\n\nInvoice {number} for {amount}.');
  return <PlaceholderField {...args} value={value} onChange={setValue} aria-label="E-mail text" />;
}

function SubjectExample(args: React.ComponentProps<typeof PlaceholderField>) {
  const [value, setValue] = useState('Invoice {number}');
  return <PlaceholderField {...args} multiline={false} value={value} onChange={setValue} aria-label="Subject" />;
}

/** A chip writes its placeholder at the cursor and leaves the focus in the text. */
export const Body: Story = { render: (args) => <BodyExample {...args} /> };

export const SingleLine: Story = { render: (args) => <SubjectExample {...args} /> };
