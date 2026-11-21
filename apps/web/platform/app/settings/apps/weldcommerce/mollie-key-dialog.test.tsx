import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ connect: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-payments-queries', () => ({
  useConnectMollieApiKey: () => ({ mutateAsync: env.connect, isPending: false }),
}));

import { MollieKeyDialog } from './mollie-key-dialog';

beforeEach(() => {
  env.connect.mockReset();
  env.connect.mockResolvedValue({ data: {} });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('MollieKeyDialog', () => {
  it('masks the key and keeps it out of autofill', () => {
    render(<MollieKeyDialog open onOpenChange={vi.fn()} />);
    const field = screen.getByLabelText('API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    expect(screen.getByText(/live_ for real payments or test_ for test payments/)).toBeTruthy();
  });

  it('connects with the key alone, says so and closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText('API key'), 'test_abcdef123456');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(env.connect).toHaveBeenCalledWith({ apiKey: 'test_abcdef123456' }));
    expect(toast.success).toHaveBeenCalledWith('Mollie connected with an API key');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends the profile id when given', async () => {
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('API key'), 'live_abcdef123456');
    await user.type(screen.getByLabelText('Profile ID (optional)'), 'pfl_9z');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(env.connect).toHaveBeenCalledWith({ apiKey: 'live_abcdef123456', profileId: 'pfl_9z' }));
  });

  it('wants a key, and one that starts with live_ or test_', async () => {
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Enter the API key.')).toBeTruthy();
    await user.type(screen.getByLabelText('API key'), 'sk_abc');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Enter a key that starts with live_ or test_.')).toBeTruthy();
    expect(env.connect).not.toHaveBeenCalled();
  });

  it('wants a profile id to start with pfl_', async () => {
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('API key'), 'test_abcdef123456');
    await user.type(screen.getByLabelText('Profile ID (optional)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('A profile ID starts with pfl_.')).toBeTruthy();
    expect(env.connect).not.toHaveBeenCalled();
  });

  it('puts MOLLIE_KEY_INVALID on the key field and stays open', async () => {
    env.connect.mockRejectedValue({ status: 400, body: { error: { code: 'MOLLIE_KEY_INVALID', message: 'x' } } });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText('API key'), 'test_abcdef123456');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Mollie did not accept this API key. Check that you copied the whole key.')).toBeTruthy();
    expect(screen.getByLabelText('API key').getAttribute('aria-invalid')).toBe('true');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows another failure in a toast', async () => {
    env.connect.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    render(<MollieKeyDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('API key'), 'test_abcdef123456');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });
});
