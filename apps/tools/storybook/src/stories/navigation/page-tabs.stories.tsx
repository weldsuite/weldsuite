import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Inbox, Users, Settings } from 'lucide-react';

import { PageTabs } from '@weldsuite/ui/components/page-tabs';

const meta = {
  title: 'Navigation/PageTabs',
  component: PageTabs,
} satisfies Meta<typeof PageTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState('inbox');
    return (
      <div className="max-w-lg">
        <PageTabs
          activeTab={active}
          onTabChange={setActive}
          tabs={[
            { id: 'inbox', label: 'Inbox', icon: Inbox, count: 12 },
            { id: 'people', label: 'People', icon: Users },
            { id: 'settings', label: 'Settings', icon: Settings },
          ]}
        />
      </div>
    );
  },
};
