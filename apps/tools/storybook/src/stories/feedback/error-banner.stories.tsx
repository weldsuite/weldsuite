import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ErrorBanner, ErrorState, InlineError } from '@weldsuite/ui/components/error-banner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';

const meta = {
  title: 'Feedback/ErrorBanner',
  component: ErrorBanner,
  args: {
    error: 'The leave request overlaps an approved request from 12 to 14 May.',
  },
  render: (args) => (
    <div className="w-[440px]">
      <ErrorBanner {...args} />
    </div>
  ),
} satisfies Meta<typeof ErrorBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dismissible: Story = {
  render: (args) => {
    const [error, setError] = useState<string | null>(args.error ?? null);
    return (
      <div className="w-[440px] space-y-3">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        {!error && (
          <Button variant="outline" size="sm" onClick={() => setError(args.error ?? null)}>
            Show again
          </Button>
        )}
      </div>
    );
  },
};

/** A long unbroken message wraps instead of widening its container. */
export const LongMessage: Story = {
  args: {
    error:
      'Request failed: https://api.example.com/v1/workspaces/ws_01HXYZABCDEFGHJKMNPQRSTVWX/payroll/runs/run_01HXYZ/approve returned 409',
  },
};

/** `ErrorState`: a section that failed to load, with a retry. */
export const LoadFailed: Story = {
  render: () => (
    <div className="w-[520px]">
      <ErrorState onRetry={() => undefined} />
    </div>
  ),
};

export const LoadFailedCustomMessage: Story = {
  render: () => (
    <div className="w-[520px]">
      <ErrorState message="The mailbox statistics are not available right now." />
    </div>
  ),
};

/** `InlineError`: one line under a control. */
export const Inline: Story = {
  render: () => (
    <div className="w-[320px] space-y-2">
      <Label htmlFor="domain">Domain</Label>
      <Input id="domain" defaultValue="acme" aria-invalid />
      <InlineError>Enter a full domain, like acme.com.</InlineError>
    </div>
  ),
};
