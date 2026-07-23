import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';

const meta = {
  title: 'Layout/ListDetailLayout',
  component: ListDetailLayout,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ListDetailLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [selected, setSelected] = useState<number | null>(null);
    return (
      <div className="h-[500px]">
        <ListDetailLayout
          isDetailSelected={selected !== null}
          list={
            <div className="flex flex-col">
              {[0, 1, 2, 3].map((i) => (
                <button
                  key={i}
                  onClick={() => setSelected(i)}
                  className="border-b px-4 py-3 text-left text-sm hover:bg-muted"
                >
                  Conversation #{i + 1}
                </button>
              ))}
            </div>
          }
        >
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            {selected === null ? 'Select a conversation' : `Viewing conversation #${selected + 1}`}
          </div>
        </ListDetailLayout>
      </div>
    );
  },
};
