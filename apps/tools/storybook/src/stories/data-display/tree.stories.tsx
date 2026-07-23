import type { Meta, StoryObj } from '@storybook/react';

import {
  TreeProvider,
  TreeView,
  TreeNode,
  TreeNodeTrigger,
  TreeNodeContent,
  TreeExpander,
  TreeIcon,
  TreeLabel,
} from '@weldsuite/ui/components/tree';

const meta = {
  title: 'Data Display/Tree',
  component: TreeView,
} satisfies Meta<typeof TreeView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-64 rounded-md border p-2">
      <TreeProvider defaultExpandedIds={['src']}>
        <TreeView>
          <TreeNode nodeId="src" level={0}>
            <TreeNodeTrigger>
              <TreeExpander hasChildren />
              <TreeIcon hasChildren />
              <TreeLabel>src</TreeLabel>
            </TreeNodeTrigger>
            <TreeNodeContent hasChildren>
              <TreeNode nodeId="components" level={1}>
                <TreeNodeTrigger>
                  <TreeExpander />
                  <TreeIcon />
                  <TreeLabel>components.tsx</TreeLabel>
                </TreeNodeTrigger>
              </TreeNode>
              <TreeNode nodeId="utils" level={1}>
                <TreeNodeTrigger>
                  <TreeExpander />
                  <TreeIcon />
                  <TreeLabel>utils.ts</TreeLabel>
                </TreeNodeTrigger>
              </TreeNode>
            </TreeNodeContent>
          </TreeNode>
        </TreeView>
      </TreeProvider>
    </div>
  ),
};
