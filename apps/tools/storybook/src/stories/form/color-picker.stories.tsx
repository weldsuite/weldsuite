import type { Meta, StoryObj } from '@storybook/react';

import {
  ColorPicker,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerOutput,
  ColorPickerFormat,
} from '@weldsuite/ui/components/color-picker';

const meta = {
  title: 'Form/ColorPicker',
  component: ColorPicker,
} satisfies Meta<typeof ColorPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-72 rounded-lg border p-4">
      <ColorPicker defaultValue="#7c3aed" className="gap-4">
        <div className="h-40">
          <ColorPickerSelection />
        </div>
        <ColorPickerHue />
        <ColorPickerAlpha />
        <div className="flex items-center gap-2">
          <ColorPickerEyeDropper />
          <ColorPickerOutput />
          <ColorPickerFormat />
        </div>
      </ColorPicker>
    </div>
  ),
};
