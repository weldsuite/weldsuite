import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ColorField } from '@weldsuite/ui/components/color-field';
import { Label } from '@weldsuite/ui/components/label';

const meta = {
  title: 'Form/ColorField',
  component: ColorField,
  args: {
    value: '#1d4ed8',
    onValueChange: () => undefined,
    swatchLabel: 'Pick the primary colour',
  },
} satisfies Meta<typeof ColorField>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The swatch and the hex code edit the same value; the label names the text field. */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('#1d4ed8');
    return (
      <div className="w-[260px] space-y-2">
        <Label htmlFor="primary">Primary colour</Label>
        <ColorField id="primary" value={value} onValueChange={setValue} swatchLabel="Pick the primary colour" />
        <p className="text-xs text-muted-foreground">Value: {value}</p>
      </div>
    );
  },
};

/** While the text is not a `#rrggbb` colour, the swatch shows the fallback and the form reports the error. */
export const Invalid: Story = {
  render: () => {
    const [value, setValue] = useState('#12');
    return (
      <div className="w-[260px] space-y-2">
        <Label htmlFor="border">Borders</Label>
        <ColorField id="border" value={value} onValueChange={setValue} swatchLabel="Pick the border colour" aria-invalid aria-describedby="border-error" />
        <p id="border-error" className="text-xs text-destructive">
          Use a colour such as #1f2937.
        </p>
      </div>
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <div className="w-[260px] space-y-2">
      <Label htmlFor="locked">Background</Label>
      <ColorField id="locked" value="#ffffff" onValueChange={() => undefined} swatchLabel="Pick the background colour" disabled />
    </div>
  ),
};
