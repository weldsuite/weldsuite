import type { Meta, StoryObj } from '@storybook/react';

import { AiProviderBadge } from '@weldsuite/ui/components/ai-provider-badge';

const meta = {
  title: 'Primitives/AiProviderBadge',
  component: AiProviderBadge,
  argTypes: {
    region: { control: 'select', options: ['eu', 'outside-eu'] },
  },
  args: {
    provider: 'Claude',
    region: 'outside-eu',
    regionLabel: 'outside the EU',
  },
} satisfies Meta<typeof AiProviderBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OutsideEu: Story = {};

export const Eu: Story = {
  args: {
    provider: 'Mistral',
    region: 'eu',
    regionLabel: 'processed in the EU',
  },
};

export const Both: Story = {
  render: () => (
    <div className="flex gap-2">
      <AiProviderBadge provider="Mistral" region="eu" regionLabel="processed in the EU" />
      <AiProviderBadge provider="Claude" region="outside-eu" regionLabel="outside the EU" />
      <AiProviderBadge provider="ChatGPT" region="outside-eu" regionLabel="outside the EU" hideIcon />
    </div>
  ),
};
