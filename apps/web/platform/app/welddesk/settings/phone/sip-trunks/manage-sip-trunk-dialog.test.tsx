import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeskSipTrunk } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { ManageSipTrunkDialog } from './manage-sip-trunk-dialog';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/queries/use-desk-sip-trunk-queries', () => ({
  sipTrunkErrorCode: () => null,
  useUpdateDeskSipTrunk: () => ({ mutateAsync: mocks.update, isPending: false }),
  useRotateDeskSipTrunkPassword: () => ({ mutateAsync: mocks.rotate, isPending: false }),
  useDeleteDeskSipTrunk: () => ({ mutateAsync: mocks.remove, isPending: false }),
  useAddDeskSipTrunkNumber: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveDeskSipTrunkNumber: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStartDeskSipVerification: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmDeskSipVerification: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const trunk = (patch: Partial<DeskSipTrunk> = {}): DeskSipTrunk => ({
  id: 'strk_1',
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  name: 'Dstny',
  provider: 'dstny',
  authMode: 'credentials',
  transport: 'udp',
  status: 'active',
  ipAddresses: [],
  lastInboundAt: null,
  lastError: null,
  numbers: [
    { id: 'vpn_1', phoneNumber: '+31201234567', displayName: null, status: 'active', allowOutbound: false, callerIdVerifiedAt: null },
    { id: 'vpn_2', phoneNumber: '+31201234568', displayName: 'Sales', status: 'active', allowOutbound: true, callerIdVerifiedAt: '2026-11-10T11:00:00.000Z' },
  ],
  connection: {
    sipHosts: [{ region: 'US', host: 'sip.telnyx.com' }],
    primaryHost: 'sip.telnyx.com',
    port: 5060,
    transport: 'udp',
    username: 'wdorg1strk1',
    signalingIps: [],
  },
  ...patch,
});

beforeEach(() => vi.clearAllMocks());

describe('ManageSipTrunkDialog', () => {
  it('shows why the last call was refused', () => {
    render(<ManageSipTrunkDialog trunk={trunk({ lastError: '+31201234567 is not a number of this phone system' })} onOpenChange={vi.fn()} canEdit />);
    expect(screen.getByText('The last call was refused')).toBeInTheDocument();
    expect(screen.getByTestId('sip-last-error')).toHaveTextContent('not a number of this phone system');
  });

  it('marks which numbers are verified for outbound caller id', () => {
    render(<ManageSipTrunkDialog trunk={trunk()} onOpenChange={vi.fn()} canEdit />);
    const rows = screen.getAllByTestId('sip-trunk-number');
    expect(rows[0]).toHaveTextContent('Not verified');
    expect(screen.getByRole('button', { name: 'Verify +31201234567 for outbound caller ID' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Verified for outbound caller ID');
    expect(screen.queryByRole('button', { name: 'Verify +31201234568 for outbound caller ID' })).not.toBeInTheDocument();
  });

  it('asks before it makes a new password, then shows it once', async () => {
    mocks.rotate.mockResolvedValue({ username: 'wdorg1strk1', password: 'NewPassw0rdNewPassw0rd' });
    render(<ManageSipTrunkDialog trunk={trunk()} onOpenChange={vi.fn()} canEdit />);
    expect(screen.queryByTestId('sip-password-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New password' }));
    expect(screen.getByText('Create a new password?')).toBeInTheDocument();
    expect(mocks.rotate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create new password' }));

    await waitFor(() => expect(screen.getByTestId('sip-password')).toHaveTextContent('NewPassw0rdNewPassw0rd'));
    expect(mocks.rotate).toHaveBeenCalledWith('strk_1');
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
  });

  it('asks before it switches off, and switches on without asking', async () => {
    mocks.update.mockResolvedValue(trunk());
    const { rerender } = render(<ManageSipTrunkDialog trunk={trunk()} onOpenChange={vi.fn()} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(screen.getByText('Switch off this phone system?')).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Switch off' }).at(-1)!);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 'strk_1', input: { status: 'disabled' } }));

    rerender(<ManageSipTrunkDialog trunk={trunk({ status: 'disabled' })} onOpenChange={vi.fn()} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 'strk_1', input: { status: 'active' } }));
  });

  it('deletes only after a confirmation, then closes', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<ManageSipTrunkDialog trunk={trunk()} onOpenChange={onOpenChange} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete phone system' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('strk_1'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers nothing to change without settings:manage', () => {
    render(<ManageSipTrunkDialog trunk={trunk()} onOpenChange={vi.fn()} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Delete phone system' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add number' })).not.toBeInTheDocument();
  });
});
