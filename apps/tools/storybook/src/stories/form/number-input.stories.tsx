import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Label } from '@weldsuite/ui/components/label';

const meta = {
  title: 'Form/NumberInput',
  component: NumberInput,
  args: {
    value: 10,
    onValueChange: () => undefined,
  },
} satisfies Meta<typeof NumberInput>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The value is a number, or `undefined` while the field is empty (never `NaN` or a string). */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<number | undefined>(25);
    return (
      <div className="w-[240px] space-y-2">
        <Label htmlFor="days">Annual leave days</Label>
        <NumberInput id="days" min={0} value={value} onValueChange={setValue} />
        <p className="text-xs text-muted-foreground">Value: {value === undefined ? 'undefined' : value}</p>
      </div>
    );
  },
};
