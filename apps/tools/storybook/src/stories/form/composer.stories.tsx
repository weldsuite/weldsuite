import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AtSign, Plus, Smile } from "lucide-react";

import {
  ComposerActions,
  ComposerFrame,
  ComposerSendButton,
  composerFieldClass,
  composerIconButtonClass,
} from "@weldsuite/ui/components/composer";

/**
 * The parts every chat composer shares (WeldAgent, WeldChat): the box, the
 * field's look, the actions row, its icon buttons and the send button. Each
 * app brings its own field and actions.
 */
const meta = {
  title: "Form/Composer",
  component: ComposerFrame,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ComposerFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

function Example({ placeholder, initial = "" }: Readonly<{ placeholder: string; initial?: string }>) {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-[480px]">
      <ComposerFrame>
        <textarea
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className={composerFieldClass}
        />
        <ComposerActions>
          <div className="flex items-center gap-0.5">
            <button type="button" aria-label="Attach" className={composerIconButtonClass}>
              <Plus className="size-[18px]" />
            </button>
            <button type="button" aria-label="Emoji" className={composerIconButtonClass}>
              <Smile className="size-[18px]" />
            </button>
            <button type="button" aria-label="Mention" className={composerIconButtonClass}>
              <AtSign className="size-[18px]" />
            </button>
          </div>
          <ComposerSendButton type="button" label="Send" canSend={value.trim().length > 0} />
        </ComposerActions>
      </ComposerFrame>
    </div>
  );
}

/** Empty: the placeholder and a grey send button. */
export const Empty: Story = {
  render: () => <Example placeholder="Type a message..." />,
};

/** With text: the send button turns solid. */
export const WithText: Story = {
  render: () => <Example placeholder="Type a message..." initial="Can you call me back?" />,
};

/** A `contentEditable` field shows its `data-placeholder` in the same grey. */
export const ContentEditableField: Story = {
  render: () => (
    <div className="w-[480px]">
      <ComposerFrame>
        <div
          contentEditable
          role="textbox"
          aria-label="Type a message..."
          data-placeholder="Type a message..."
          className={composerFieldClass}
        />
        <ComposerActions>
          <div />
          <ComposerSendButton type="button" label="Send" canSend={false} />
        </ComposerActions>
      </ComposerFrame>
    </div>
  ),
};

/** While a message is on its way. */
export const Sending: Story = {
  render: () => (
    <div className="w-[480px]">
      <ComposerFrame>
        <textarea rows={1} readOnly value="On its way" aria-label="Message" className={composerFieldClass} />
        <ComposerActions>
          <div />
          <ComposerSendButton type="button" label="Send" canSend isSending />
        </ComposerActions>
      </ComposerFrame>
    </div>
  ),
};
