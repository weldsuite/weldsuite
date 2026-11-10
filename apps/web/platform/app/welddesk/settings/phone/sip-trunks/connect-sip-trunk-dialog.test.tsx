import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeskSipTrunkCreated } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { ConnectSipTrunkDialog } from './connect-sip-trunk-dialog';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  addNumber: vi.fn(),
  trunks: { data: [] as unknown[] },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/queries/use-desk-sip-trunk-queries', () => ({
  sipTrunkErrorCode: (err: unknown) => (err as { body?: { error?: { code?: string } } })?.body?.error?.code ?? null,
  useDeskSipTrunks: () => mocks.trunks,
  useCreateDeskSipTrunk: () => ({ mutateAsync: mocks.create, isPending: false }),
  useAddDeskSipTrunkNumber: () => ({ mutateAsync: mocks.addNumber, isPending: false }),
  useRemoveDeskSipTrunkNumber: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStartDeskSipVerification: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmDeskSipVerification: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const connection = {
  sipHosts: [
    { region: 'US', host: 'sip.telnyx.com' },
    { region: 'EU', host: 'sip.telnyx.eu' },
  ],
  primaryHost: 'sip.telnyx.com',
  port: 5060,
  transport: 'udp' as const,
  username: null as string | null,
  signalingIps: [
    { region: 'US', ip: '192.76.120.10' },
    { region: 'EU', ip: '185.246.41.140' },
  ],
};

const created = (patch: Partial<DeskSipTrunkCreated>): DeskSipTrunkCreated => ({
  id: 'strk_1',
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  name: 'Head office',
  provider: 'xelion',
  authMode: 'credentials',
  transport: 'udp',
  status: 'active',
  ipAddresses: [],
  lastInboundAt: null,
  lastError: null,
  numbers: [],
  connection,
  credentials: null,
  ...patch,
});

const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

function open() {
  render(<ConnectSipTrunkDialog open onOpenChange={vi.fn()} canEdit />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trunks.data = [];
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});

describe('ConnectSipTrunkDialog', () => {
  it('asks for a name before it connects anything', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(screen.getByText('Enter a name')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('checks the IP addresses of an IP phone system', () => {
    open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Head office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(screen.getByText('Add at least one IP address')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Public IP addresses of your phone system'), { target: { value: '300.1.1.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(screen.getByText('300.1.1.1 is not a valid IPv4 address')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates an IP connection and lists the addresses to allow', async () => {
    mocks.create.mockResolvedValue(created({ authMode: 'ip', ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1', port: 5070 }] }));
    open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Head office ' } });
    fireEvent.change(screen.getByLabelText('Public IP addresses of your phone system'), { target: { value: '8.8.8.8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add IP address' }));
    const [, second] = screen.getAllByLabelText('Public IP addresses of your phone system');
    fireEvent.change(second!, { target: { value: '1.1.1.1' } });
    fireEvent.change(screen.getAllByLabelText('Port')[1]!, { target: { value: '5070' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(screen.getByTestId('sip-step-two')).toBeInTheDocument());
    expect(mocks.create).toHaveBeenCalledWith({
      name: 'Head office',
      provider: 'xelion',
      authMode: 'ip',
      transport: 'udp',
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1', port: 5070 }],
    });
    expect(screen.getByTestId('sip-host')).toHaveTextContent('sip.telnyx.com');
    expect(screen.getByTestId('sip-signaling-ips')).toHaveTextContent('192.76.120.10');
    expect(screen.queryByTestId('sip-password-panel')).not.toBeInTheDocument();
  });

  it('shows the password of a login connection once, with a warning and a copy button', async () => {
    mocks.create.mockResolvedValue(
      created({ connection: { ...connection, username: 'wdorg1strk1' }, credentials: { username: 'wdorg1strk1', password: 'Abcdefgh23456789Abcdefgh' } }),
    );
    open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dstny' } });
    fireEvent.click(screen.getByLabelText('Dstny'));
    fireEvent.click(screen.getByLabelText('With a username and password'));
    fireEvent.click(screen.getByLabelText('TLS (encrypted)'));
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(screen.getByTestId('sip-password-panel')).toBeInTheDocument());
    expect(mocks.create).toHaveBeenCalledWith({ name: 'Dstny', provider: 'dstny', authMode: 'credentials', transport: 'tls' });
    expect(screen.getByTestId('sip-username')).toHaveTextContent('wdorg1strk1');
    expect(screen.getByTestId('sip-password')).toHaveTextContent('Abcdefgh23456789Abcdefgh');
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(screen.queryByTestId('sip-signaling-ips')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Password' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('Abcdefgh23456789Abcdefgh'));
  });

  it('adds numbers in step three and reports a number that is taken', async () => {
    mocks.create.mockResolvedValue(created({ connection: { ...connection, username: 'wdx' }, credentials: { username: 'wdx', password: 'Abcdefgh23456789Abcdefgh' } }));
    mocks.addNumber.mockRejectedValueOnce({ body: { error: { code: 'number_taken' } } }).mockResolvedValueOnce({ id: 'vpn_1' });
    open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dstny' } });
    fireEvent.click(screen.getByLabelText('With a username and password'));
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByTestId('sip-step-two')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('sip-step-three')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+31201234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add number' }));
    expect(await screen.findByText('This number is already in use')).toBeInTheDocument();
    expect(mocks.addNumber).toHaveBeenCalledWith({ trunkId: 'strk_1', input: { phoneNumber: '+31201234567' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add number' }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Number added'));
  });
});
