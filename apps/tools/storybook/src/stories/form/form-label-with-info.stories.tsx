import type { Meta, StoryObj } from '@storybook/react';

import { FormLabelWithInfo } from '@weldsuite/ui/components/form-label-with-info';
import { Input } from '@weldsuite/ui/components/input';

const meta = {
  title: 'Form/FormLabelWithInfo',
  component: FormLabelWithInfo,
} satisfies Meta<typeof FormLabelWithInfo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithTooltip: Story = {
  render: () => (
    <div className="grid w-64 gap-1.5">
      <FormLabelWithInfo htmlFor="acct" required infoTooltip="Format: 1000-9999">
        Account Number
      </FormLabelWithInfo>
      <Input id="acct" placeholder="1000" />
    </div>
  ),
};

export const WithPopover: Story = {
  render: () => (
    <div className="grid w-64 gap-1.5">
      <FormLabelWithInfo
        htmlFor="terms"
        infoPopover={{
          title: 'Payment Terms',
          content: 'Determines when invoices are due (e.g. Net 30).',
        }}
      >
        Payment Terms
      </FormLabelWithInfo>
      <Input id="terms" placeholder="Net 30" />
    </div>
  ),
};
