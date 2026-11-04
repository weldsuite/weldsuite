import type { Meta, StoryObj } from '@storybook/react';

import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { Badge } from '@weldsuite/ui/components/badge';

const meta = {
  title: 'Data Display/FieldGrid',
  component: FieldGrid,
  args: {
    fields: [
      { label: 'Email', value: 'jane@acme.com' },
      { label: 'Phone', value: '+31 20 123 4567' },
      { label: 'Start date', value: '3 March 2024' },
      { label: 'Status', value: <Badge variant="success">Active</Badge> },
      { label: 'Manager', value: null },
      { label: 'Contract', value: undefined },
    ],
  },
  render: (args) => (
    <div className="w-[520px]">
      <FieldGrid {...args} />
    </div>
  ),
} satisfies Meta<typeof FieldGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty values render as an em dash. */
export const Default: Story = {};
