import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";

import { InlineTextEditor } from "@weldsuite/ui/components/inline-text-editor";

const meta = {
  title: "Form/InlineTextEditor",
  component: InlineTextEditor,
  args: { value: "Prepare the quarterly report", onSave: () => {} },
} satisfies Meta<typeof InlineTextEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Editable(props: Readonly<React.ComponentProps<typeof InlineTextEditor>>) {
  const [value, setValue] = React.useState(props.value);
  return <InlineTextEditor {...props} value={value} onSave={setValue} />;
}

/** A task title or record name: click (or Enter) to edit, Enter or blur saves, Escape cancels. It wraps. */
export const Default: Story = {
  render: (args) => (
    <div className="max-w-sm p-6">
      <Editable {...args} label="Task title" className="text-lg font-semibold" />
    </div>
  ),
};

/** One line that hugs its text, as in a header bar: the editor grows as you type. */
export const SingleLine: Story = {
  args: { value: "Recording of Noah Taylor" },
  render: (args) => (
    <div className="flex items-center gap-3 border-b p-3">
      <Editable {...args} singleLine label="Title" className="mx-0 text-[15px] font-medium leading-6 text-foreground focus:border-primary focus:ring-0" />
      <span className="text-sm text-muted-foreground">Started Nov 19, 2026</span>
    </div>
  ),
};
