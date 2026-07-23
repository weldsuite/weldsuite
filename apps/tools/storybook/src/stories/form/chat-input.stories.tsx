import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Sparkles } from "lucide-react";

import { ChatInput, type MentionOption } from "@weldsuite/ui/components/chat-input";

const WORKSPACE_MEMBERS: MentionOption[] = [
  { userId: "u_alice", name: "Alice Johnson", email: "alice@acme.com" },
  { userId: "u_bob", name: "Bob Smith", email: "bob@acme.com" },
  { userId: "u_charlie", name: "Charlie Davis", email: "charlie@acme.com" },
  { userId: "u_dana", name: "Dana Lee", email: "dana@acme.com" },
];

const meta = {
  title: "Form/ChatInput",
  component: ChatInput,
  parameters: { layout: "centered" },
  argTypes: {
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    submitDisabled: { control: "boolean" },
    rows: { control: { type: "number", min: 1, max: 6, step: 1 } },
  },
} satisfies Meta<typeof ChatInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: "Type a message...",
  },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={({ content, mentions }) => {
            alert(`Send: ${content}\nMentions: ${mentions.join(", ") || "(none)"}`);
            setValue("");
          }}
          onAttach={() => alert("Attach")}
          onEmoji={() => alert("Emoji")}
          onFormat={() => alert("Format")}
          onVideo={() => alert("Record video")}
          onAudio={() => alert("Record audio")}
        />
      </div>
    );
  },
};

export const WithMentions: Story = {
  args: { placeholder: "Message the team..." },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          mentionOptions={WORKSPACE_MEMBERS}
          onSend={({ content, mentions }) => {
            alert(`Send: ${content}\nMentions: ${mentions.join(", ") || "(none)"}`);
            setValue("");
          }}
          onAttach={() => {}}
          onEmoji={() => {}}
        />
      </div>
    );
  },
};

export const Minimal: Story = {
  args: { placeholder: "Reply..." },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[420px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={() => setValue("")}
        />
      </div>
    );
  },
};

export const WithAttachmentsOnly: Story = {
  args: { placeholder: "Message #general" },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={() => setValue("")}
          onAttach={() => alert("Attach")}
          onEmoji={() => alert("Emoji")}
        />
      </div>
    );
  },
};

export const Recording: Story = {
  args: { placeholder: "Recording audio..." },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={() => setValue("")}
          onAttach={() => {}}
          onEmoji={() => {}}
          onVideo={() => {}}
          onAudio={() => {}}
          recording="audio"
        />
      </div>
    );
  },
};

export const WithTopSlot: Story = {
  args: { placeholder: "Reply in thread..." },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={() => setValue("")}
          onAttach={() => {}}
          onEmoji={() => {}}
          topSlot={
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>Replying to <span className="text-foreground font-medium">daniel snelderwaard</span>: &ldquo;effe&rdquo;</span>
              <button className="hover:text-foreground" onClick={() => alert("Clear reply")}>Clear</button>
            </div>
          }
        />
      </div>
    );
  },
};

export const WithExtraAction: Story = {
  args: { placeholder: "Ask WeldAgent..." },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[560px]">
        <ChatInput
          {...args}
          value={value}
          onValueChange={setValue}
          onSend={() => setValue("")}
          onAttach={() => {}}
          onEmoji={() => {}}
          extraActions={[
            {
              icon: Sparkles,
              label: "Ask AI",
              onClick: () => alert("AI"),
            },
          ]}
        />
      </div>
    );
  },
};

export const Disabled: Story = {
  args: { placeholder: "You don't have permission to post", disabled: true },
  render: (args) => (
    <div className="w-[560px]">
      <ChatInput
        {...args}
        value=""
        onValueChange={() => {}}
        onSend={() => {}}
        onAttach={() => {}}
        onEmoji={() => {}}
      />
    </div>
  ),
};
