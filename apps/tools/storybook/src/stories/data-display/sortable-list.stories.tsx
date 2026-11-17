import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { SortableList } from '@weldsuite/ui/components/sortable-list';

interface Rule {
  id: string;
  pattern: string;
  replacement: string;
}

const RULES: Rule[] = [
  { id: 'r1', pattern: '^/users/\\d+', replacement: '/users/:id' },
  { id: 'r2', pattern: '^/blog/\\d{4}/\\d{2}/', replacement: '/blog/:year/:month/' },
  { id: 'r3', pattern: '\\?.*$', replacement: '' },
];

function Demo({ disabled = false }: { disabled?: boolean }) {
  const [rules, setRules] = useState(RULES);
  return (
    <div className="w-[28rem]">
      <SortableList
        items={rules}
        getId={(rule) => rule.id}
        onReorder={setRules}
        disabled={disabled}
        handleLabel={(_, index) => `Drag rule ${index + 1} to reorder`}
        renderItem={(rule, index) => (
          <p className="text-sm">
            <span className="mr-2 text-muted-foreground">{index + 1}</span>
            <code>{rule.pattern}</code> → <code>{rule.replacement || '(empty)'}</code>
          </p>
        )}
      />
    </div>
  );
}

const meta = {
  title: 'Data Display/SortableList',
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ReadOnly: Story = { args: { disabled: true } };
