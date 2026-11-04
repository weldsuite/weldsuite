import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { FilterSelect } from '@weldsuite/ui/components/filter-select';

const STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
];

const meta = {
  title: 'Form/FilterSelect',
  component: FilterSelect,
  args: {
    value: undefined,
    onChange: () => undefined,
    options: STATUSES,
    allLabel: 'All statuses',
    ariaLabel: 'Filter by status',
  },
} satisfies Meta<typeof FilterSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState<string | undefined>(undefined);
    return (
      <div className="flex items-center gap-3">
        <FilterSelect {...args} value={value} onChange={setValue} />
        <span className="text-sm text-muted-foreground">Filter: {value ?? 'none'}</span>
      </div>
    );
  },
};

export const WithValue: Story = {
  render: (args) => {
    const [value, setValue] = useState<string | undefined>('active');
    return <FilterSelect {...args} value={value} onChange={setValue} />;
  },
};
