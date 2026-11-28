import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { SegmentedControl } from '@weldsuite/ui/components/segmented-control';

const options = [
  { value: 'project', label: 'Per project' },
  { value: 'person', label: 'Per person' },
  { value: 'activity', label: 'Per activity' },
  { value: 'entry', label: 'Every entry' },
] as const;

type Grouping = (typeof options)[number]['value'];

const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl,
  args: { options, value: 'project', onChange: () => {}, ariaLabel: 'Group the invoice lines' },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One segment is always selected; arrow keys move between them and pressing the selected one keeps it. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState<Grouping>('project');
    return <SegmentedControl {...args} value={value} onChange={(next) => setValue(next as Grouping)} />;
  },
};

/** The default size is taller, for a control that is the main choice of a page. */
export const DefaultSize: Story = { args: { size: 'default', value: 'person' } };
