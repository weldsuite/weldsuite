import type { Meta, StoryObj } from '@storybook/react';

import { WorldMap, type WorldMapItem } from '@weldsuite/ui/components/world-map';

const names = new Intl.DisplayNames(['en'], { type: 'region' });
const visitors: WorldMapItem[] = (
  [
    ['NL', 14],
    ['US', 9],
    ['DE', 6],
    ['GB', 4],
    ['BE', 3],
    ['IN', 2],
    ['BR', 1],
    ['SG', 1],
  ] as const
).map(([code, value]) => ({ code, label: names.of(code) ?? code, value, display: String(value) }));

const meta = {
  title: 'Charts/WorldMap',
  component: WorldMap,
  parameters: {
    docs: {
      description: {
        component:
          'Every country in a muted grey; the ones with a value are tinted, with a dot sized by the value. Hover a country or dot for its card. The map keeps its shape in any box: `align` says where it sits.',
      },
    },
  },
  args: { items: visitors, valueLabel: 'Active visitors', countryLabel: 'Country', label: 'Active visitors by country' },
  decorators: [
    (Story) => (
      <div style={{ width: 900, height: 420 }} className="rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorldMap>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Visitors: Story = { args: { className: 'h-full' } };

/** Drag to move; pinch, ⌘/Ctrl + scroll or double-click to zoom; the buttons zoom in, out and back. */
export const Zoomable: Story = {
  args: { className: 'h-full', zoom: { zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Show the whole world' } },
};

/** In a wide strip with the map on the right, leaving room for a card on the left. */
export const AlignedRight: Story = {
  name: 'Aligned right',
  args: { className: 'h-full', align: 'right' },
  decorators: [
    (Story) => (
      <div style={{ width: 1200, height: 340 }}>
        <Story />
      </div>
    ),
  ],
};

export const Empty: Story = { args: { className: 'h-full', items: [] } };
