import type { Meta, StoryObj } from '@storybook/react';

import { GLYPH_TONES, GlyphBadge } from '@weldsuite/ui/components/glyph-badge';

const meta = {
  title: 'Primitives/GlyphBadge',
  component: GlyphBadge,
  argTypes: {
    tone: { control: 'select', options: GLYPH_TONES },
    size: { control: 'select', options: ['sm', 'md'] },
  },
  args: { glyph: 'E', tone: 'violet', label: 'Epic', size: 'md' },
} satisfies Meta<typeof GlyphBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The item types of a WeldFlow backlog. */
export const ItemTypes: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-sm">
      {(
        [
          ['E', 'violet', 'Epic'],
          ['F', 'pink', 'Feature'],
          ['P', 'green', 'PBI'],
          ['B', 'red', 'Bug'],
          ['T', 'blue', 'Task'],
          ['S', 'amber', 'Spike'],
          ['↳', 'neutral', 'Subtask'],
        ] as const
      ).map(([glyph, tone, label]) => (
        <div key={label} className="flex items-center gap-2">
          <GlyphBadge glyph={glyph} tone={tone} label={label} />
          <span>{label}</span>
        </div>
      ))}
    </div>
  ),
};

export const Small: Story = {
  args: { size: 'sm', glyph: 'B', tone: 'red', label: 'Bug' },
};
