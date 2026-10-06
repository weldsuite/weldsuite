import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
// The same two modules the app uses: the root route mounts this Toaster, and
// platform code calls `toast` from its own `sonner` dependency. They only share
// a toast store while `sonner` is deduped (vite.config.ts / vitest.config.ts);
// without that, each package resolves its own copy and nothing is rendered.
import { Toaster } from '@weldsuite/ui/components/sonner';
import { toast } from 'sonner';

describe('toasts', () => {
  it('renders a toast fired from platform code in the mounted Toaster', async () => {
    render(<Toaster />);

    act(() => {
      toast.success('Link copied');
    });

    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });
});
