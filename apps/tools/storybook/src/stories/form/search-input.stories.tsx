import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { SearchInput } from '@weldsuite/ui/components/search-input';

const meta = {
  title: 'Form/SearchInput',
  component: SearchInput,
  args: {
    placeholder: 'Search files',
  },
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fixed width next to filters in a toolbar. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState('');
    return <SearchInput {...args} className="w-56" value={value} onChange={(event) => setValue(event.target.value)} aria-label="Search files" />;
  },
};

/** The full width of a side pane, above the list it searches. */
export const FullWidth: Story = {
  render: (args) => {
    const [value, setValue] = useState('');
    return (
      <div className="w-72 space-y-2 border-r p-3">
        <SearchInput {...args} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Search files" />
        <p className="text-xs text-muted-foreground">0 of 20 viewed</p>
      </div>
    );
  },
};
