import type { Meta, StoryObj } from "@storybook/react";

import {
  FormField,
  FormInput,
  FormTextarea,
  FormSelect,
  FormCheckbox,
} from "@weldsuite/ui/components/form-field";

const meta = {
  title: "Form/FormField",
  component: FormField,
  parameters: { layout: "centered" },
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithInput: Story = {
  render: () => (
    <div className="w-[320px]">
      <FormInput label="Email" placeholder="you@example.com" required />
    </div>
  ),
};

export const WithError: Story = {
  render: () => (
    <div className="w-[320px]">
      <FormInput
        label="Email"
        placeholder="you@example.com"
        error="Please enter a valid email address"
        required
      />
    </div>
  ),
};

export const WithTextarea: Story = {
  render: () => (
    <div className="w-[320px]">
      <FormTextarea
        label="Description"
        placeholder="Tell us more..."
        helpText="Maximum 500 characters"
      />
    </div>
  ),
};

export const WithSelect: Story = {
  render: () => (
    <div className="w-[320px]">
      <FormSelect
        label="Country"
        required
        options={[
          { value: "us", label: "United States" },
          { value: "uk", label: "United Kingdom" },
          { value: "nl", label: "Netherlands" },
        ]}
      />
    </div>
  ),
};

export const WithCheckbox: Story = {
  render: () => (
    <div className="w-[320px]">
      <FormCheckbox label="I agree to the terms and conditions" />
    </div>
  ),
};
