import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';

import { ZoomControls } from '@weldsuite/ui/components/zoom-controls';

const meta = {
  title: 'Data Display/ZoomControls',
  component: ZoomControls,
  parameters: {
    docs: {
      description: {
        component:
          'Zoom in, zoom out and fit, in one bordered column: the corner controls of the workflow canvas and the world map. The caller places it.',
      },
    },
  },
  args: {
    onZoomIn: fn(),
    onZoomOut: fn(),
    onReset: fn(),
    labels: { zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Reset layout' },
  },
} satisfies Meta<typeof ZoomControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
