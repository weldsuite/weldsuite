import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import {
  Briefcase,
  Building2,
  Headphones,
  Mail,
  MessageSquare,
  Users,
} from "lucide-react";

import {
  MultiSelect,
  type MultiSelectOption,
} from "@weldsuite/ui/components/multi-select";
import { Label } from "@weldsuite/ui/components/label";

const FRUITS: MultiSelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "orange", label: "Orange" },
  { value: "grape", label: "Grape" },
  { value: "pear", label: "Pear" },
  { value: "mango", label: "Mango" },
  { value: "pineapple", label: "Pineapple" },
  { value: "strawberry", label: "Strawberry" },
];

const APPS: MultiSelectOption[] = [
  { value: "crm", label: "CRM", icon: <Users className="size-4" /> },
  { value: "projects", label: "Projects", icon: <Briefcase className="size-4" /> },
  { value: "mail", label: "Mail", icon: <Mail className="size-4" /> },
  { value: "helpdesk", label: "Helpdesk", icon: <Headphones className="size-4" /> },
  { value: "chat", label: "Chat", icon: <MessageSquare className="size-4" /> },
  {
    value: "commerce",
    label: "Commerce",
    icon: <Building2 className="size-4" />,
    disabled: true,
  },
];

const meta = {
  title: "Form/MultiSelect",
  component: MultiSelect,
  parameters: { layout: "centered" },
  argTypes: {
    placeholder: { control: "text" },
    searchPlaceholder: { control: "text" },
    emptyText: { control: "text" },
    searchable: { control: "boolean" },
    disabled: { control: "boolean" },
    maxDisplay: { control: { type: "number", min: 1, step: 1 } },
  },
} satisfies Meta<typeof MultiSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    options: FRUITS,
    placeholder: "Select fruits…",
    searchPlaceholder: "Search fruits…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

export const WithLabel: Story = {
  args: {
    options: FRUITS,
    placeholder: "Select fruits…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <div className="grid w-[320px] gap-1.5">
        <Label htmlFor="fruits">Favorite fruits</Label>
        <MultiSelect
          {...args}
          id="fruits"
          value={value}
          onChange={setValue}
        />
      </div>
    );
  },
};

export const WithIcons: Story = {
  args: {
    options: APPS,
    placeholder: "Select apps…",
    searchPlaceholder: "Search apps…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

export const Preselected: Story = {
  args: {
    options: APPS,
    placeholder: "Select apps…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>(["crm", "projects", "mail"]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

export const OverflowCount: Story = {
  args: {
    options: FRUITS,
    maxDisplay: 3,
    placeholder: "Select fruits…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>([
      "apple",
      "banana",
      "orange",
      "grape",
      "pear",
    ]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

const PEOPLE: MultiSelectOption[] = [
  { value: "user_1", label: "Sam Jansen", description: "sam@example.com" },
  { value: "user_2", label: "Sam Jansen", description: "sam.jansen@example.org" },
  { value: "user_3", label: "Alex de Vries", description: "alex@example.com" },
];

/** Two options share a label: the description tells them apart, and search matches it. */
export const WithDescriptions: Story = {
  args: {
    options: PEOPLE,
    placeholder: "Select people…",
    searchPlaceholder: "Search by name or email…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

export const NotSearchable: Story = {
  args: {
    options: APPS,
    searchable: false,
    placeholder: "Select apps…",
  },
  render: (args) => {
    const [value, setValue] = useState<string[]>(["crm"]);
    return (
      <div className="w-[320px]">
        <MultiSelect {...args} value={value} onChange={setValue} />
      </div>
    );
  },
};

export const Disabled: Story = {
  args: {
    options: APPS,
    disabled: true,
    placeholder: "Select apps…",
  },
  render: (args) => (
    <div className="w-[320px]">
      <MultiSelect {...args} value={["crm", "mail"]} onChange={() => {}} />
    </div>
  ),
};
