import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SipNumberVerification } from './sip-number-verification';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/queries/use-desk-sip-trunk-queries', () => ({
  sipTrunkErrorCode: (err: unknown) => (err as { body?: { error?: { code?: string } } })?.body?.error?.code ?? null,
  useStartDeskSipVerification: () => ({ mutateAsync: mocks.start, isPending: false }),
  useConfirmDeskSipVerification: () => ({ mutateAsync: mocks.confirm, isPending: false }),
}));

const number = { id: 'vpn_1', phoneNumber: '+31201234567' };

function open(onOpenChange = vi.fn()) {
  render(<SipNumberVerification open onOpenChange={onOpenChange} trunkId="strk_1" number={number} />);
  return onOpenChange;
}

beforeEach(() => vi.clearAllMocks());

describe('SipNumberVerification', () => {
  it('sends the code by call, then confirms it and closes', async () => {
    mocks.start.mockResolvedValue({ method: 'call', phoneNumber: number.phoneNumber });
    mocks.confirm.mockResolvedValue({ id: 'vpn_1' });
    const onOpenChange = open();
    expect(screen.getByText('Verify +31201234567')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeInTheDocument());
    expect(mocks.start).toHaveBeenCalledWith({ trunkId: 'strk_1', numberId: 'vpn_1', method: 'call' });

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith({ trunkId: 'strk_1', numberId: 'vpn_1', code: '123456' }));
    expect(mocks.toast.success).toHaveBeenCalledWith('Number verified');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('can send the code by text message', async () => {
    mocks.start.mockResolvedValue({ method: 'sms', phoneNumber: number.phoneNumber });
    open();
    fireEvent.click(screen.getByLabelText('Text message'));
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ trunkId: 'strk_1', numberId: 'vpn_1', method: 'sms' }));
  });

  it('says so when the code is wrong or has expired, and stays open', async () => {
    mocks.start.mockResolvedValue({ method: 'call', phoneNumber: number.phoneNumber });
    mocks.confirm
      .mockRejectedValueOnce({ body: { error: { code: 'wrong_code' } } })
      .mockRejectedValueOnce({ body: { error: { code: 'code_expired' } } });
    const onOpenChange = open();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const input = await screen.findByLabelText('Verification code');

    fireEvent.change(input, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    expect(await screen.findByText('That code is not right')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    expect(await screen.findByText('The code has expired. Ask for a new one.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('says so when too many codes were sent or tried', async () => {
    mocks.start
      .mockRejectedValueOnce({ body: { error: { code: 'too_many_attempts' } } })
      .mockResolvedValueOnce({ method: 'call', phoneNumber: number.phoneNumber });
    mocks.confirm.mockRejectedValueOnce({ body: { error: { code: 'too_many_attempts' } } });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Too many attempts. Wait an hour and try again.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    const input = await screen.findByLabelText('Verification code');
    fireEvent.change(input, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify number' }));
    expect(await screen.findByText('Too many attempts. Wait an hour and try again.')).toBeInTheDocument();
  });

  it('explains a number Telnyx could not reach', async () => {
    mocks.start.mockRejectedValue({ body: { error: { code: 'verification_refused' } } });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('We could not send a code to this number')).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });
});
