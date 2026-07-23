import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Building2, Mail, User } from "lucide-react";

import {
  Autocomplete,
  type AutocompleteOption,
} from "@weldsuite/ui/components/autocomplete";
import { Label } from "@weldsuite/ui/components/label";

const FRUITS: AutocompleteOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "orange", label: "Orange" },
  { value: "grape", label: "Grape" },
  { value: "pear", label: "Pear" },
  { value: "mango", label: "Mango" },
  { value: "pineapple", label: "Pineapple" },
  { value: "strawberry", label: "Strawberry" },
];

const CONTACTS: AutocompleteOption[] = [
  {
    value: "1",
    label: "Alice Johnson",
    description: "alice@acme.com",
    icon: <User className="h-4 w-4" />,
  },
  {
    value: "2",
    label: "Bob Smith",
    description: "bob@globex.com",
    icon: <User className="h-4 w-4" />,
  },
  {
    value: "3",
    label: "Charlie Davis",
    description: "charlie@initech.com",
    icon: <User className="h-4 w-4" />,
  },
  {
    value: "4",
    label: "Dana Lee",
    description: "dana@soylent.com",
    icon: <User className="h-4 w-4" />,
    disabled: true,
  },
];

const meta = {
  title: "Form/Autocomplete",
  component: Autocomplete,
  parameters: { layout: "centered" },
  argTypes: {
    placeholder: { control: "text" },
    searchPlaceholder: { control: "text" },
    emptyText: { control: "text" },
    disabled: { control: "boolean" },
    clearable: { control: "boolean" },
    loading: { control: "boolean" },
    debounceMs: { control: { type: "number", min: 0, step: 50 } },
    minSearchLength: { control: { type: "number", min: 0, step: 1 } },
  },
} satisfies Meta<typeof Autocomplete>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    options: FRUITS,
    placeholder: "Select a fruit...",
    searchPlaceholder: "Search fruits...",
  },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[280px]">
        <Autocomplete {...args} value={value} onValueChange={setValue} />
      </div>
    );
  },
};

export const WithLabel: Story = {
  args: {
    options: FRUITS,
    placeholder: "Select a fruit...",
  },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="grid gap-1.5 w-[280px]">
        <Label>Favorite fruit</Label>
        <Autocomplete {...args} value={value} onValueChange={setValue} />
      </div>
    );
  },
};

export const WithIconsAndDescriptions: Story = {
  args: {
    options: CONTACTS,
    placeholder: "Select a contact...",
    searchPlaceholder: "Search contacts...",
  },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[320px]">
        <Autocomplete {...args} value={value} onValueChange={setValue} />
      </div>
    );
  },
};

export const Loading: Story = {
  args: {
    options: [],
    loading: true,
    placeholder: "Loading data...",
  },
  render: (args) => (
    <div className="w-[280px]">
      <Autocomplete {...args} />
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    options: FRUITS,
    disabled: true,
    placeholder: "Disabled autocomplete",
  },
  render: (args) => (
    <div className="w-[280px]">
      <Autocomplete {...args} value="apple" />
    </div>
  ),
};

export const NotClearable: Story = {
  args: {
    options: FRUITS,
    clearable: false,
    placeholder: "Pick one (no clear button)",
  },
  render: (args) => {
    const [value, setValue] = useState("apple");
    return (
      <div className="w-[280px]">
        <Autocomplete {...args} value={value} onValueChange={setValue} />
      </div>
    );
  },
};

const COUNTRIES: AutocompleteOption[] = [
  { value: "us", label: "United States", icon: <Building2 className="h-4 w-4" /> },
  { value: "uk", label: "United Kingdom", icon: <Building2 className="h-4 w-4" /> },
  { value: "nl", label: "Netherlands", icon: <Building2 className="h-4 w-4" /> },
  { value: "de", label: "Germany", icon: <Building2 className="h-4 w-4" /> },
  { value: "fr", label: "France", icon: <Building2 className="h-4 w-4" /> },
  { value: "es", label: "Spain", icon: <Building2 className="h-4 w-4" /> },
  { value: "it", label: "Italy", icon: <Building2 className="h-4 w-4" /> },
  { value: "jp", label: "Japan", icon: <Building2 className="h-4 w-4" /> },
  { value: "cn", label: "China", icon: <Building2 className="h-4 w-4" /> },
  { value: "br", label: "Brazil", icon: <Building2 className="h-4 w-4" /> },
];

export const AsyncSearch: Story = {
  args: {
    placeholder: "Search countries...",
    searchPlaceholder: "Type to search...",
    minSearchLength: 2,
    debounceMs: 300,
  },
  render: (args) => {
    const [value, setValue] = useState("");
    const onSearch = async (query: string): Promise<AutocompleteOption[]> => {
      await new Promise((r) => setTimeout(r, 500));
      const q = query.toLowerCase();
      return COUNTRIES.filter((c) => c.label.toLowerCase().includes(q));
    };
    return (
      <div className="w-[320px]">
        <Autocomplete
          {...args}
          value={value}
          onValueChange={setValue}
          onSearch={onSearch}
        />
      </div>
    );
  },
};

export const CustomRender: Story = {
  args: {
    options: CONTACTS,
    placeholder: "Select a contact...",
  },
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div className="w-[340px]">
        <Autocomplete
          {...args}
          value={value}
          onValueChange={setValue}
          renderOption={(option) => (
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                <User className="h-4 w-4" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Mail className="h-3 w-3" />
                  {option.description}
                </span>
              </div>
            </div>
          )}
        />
      </div>
    );
  },
};
