import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const navigate = vi.fn();
const callState = {
  phoneNumbers: [] as Array<{ id: string }>,
  isDialerOpen: false,
  callState: null as Record<string, unknown> | null,
  callStreams: { local: null, remote: null },
  isMinimized: false,
  setIsDialerOpen: vi.fn(),
  setInitialDialerNumber: vi.fn(),
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  toggleHold: vi.fn(),
  sendDigits: vi.fn(),
};

const activeCall = (overrides: Record<string, unknown> = {}) => ({
  status: 'connected',
  toNumber: '+31612345678',
  fromNumber: '+442079460123',
  duration: 65,
  isRecording: true,
  isMuted: false,
  isOnHold: false,
  ...overrides,
});

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@clerk/clerk-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/clerk-react')>()),
  useUser: () => ({ user: { id: 'user_1', fullName: 'Daniel S', imageUrl: undefined } }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/contexts/call-context', () => ({ useCall: () => callState }));
vi.mock('../components/weldcall-gate', () => ({
  WeldCallGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import NewCallPage from './page';

describe('WeldCall landing page', () => {
  beforeEach(() => {
    navigate.mockReset();
    callState.phoneNumbers = [];
    callState.isDialerOpen = false;
    callState.callState = null;
    callState.isMinimized = false;
  });

  it('says up front that a number is needed and links to its setup', () => {
    render(<NewCallPage />);

    expect(screen.getByTestId('weldcall-no-number')).toHaveTextContent('Connect a phone number first');

    fireEvent.click(screen.getByRole('button', { name: /configure number/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/apps/phone-numbers' });
  });

  it('drops the notice once the workspace has a number', () => {
    callState.phoneNumbers = [{ id: 'pn_1' }];
    render(<NewCallPage />);

    expect(screen.queryByTestId('weldcall-no-number')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter a phone number')).toBeInTheDocument();
  });

  it('opens the dialer straight from New call, without a menu', () => {
    callState.phoneNumbers = [{ id: 'pn_1' }];
    render(<NewCallPage />);

    fireEvent.click(screen.getByRole('button', { name: 'New call' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(callState.setInitialDialerNumber).toHaveBeenCalledWith('');
    expect(callState.setIsDialerOpen).toHaveBeenCalledWith(true);
  });

  it('leaves the page as it is while the floating dialer is open', () => {
    const { rerender } = render(<NewCallPage />);
    const before = screen.getByTestId('weldcall-landing').className;

    callState.isDialerOpen = true;
    rerender(<NewCallPage />);
    expect(screen.getByTestId('weldcall-landing').className).toBe(before);
  });

  it('turns into the call screen while a call is on', () => {
    callState.callState = activeCall();
    callState.isMinimized = true;
    render(<NewCallPage />);

    expect(screen.queryByTestId('weldcall-landing')).not.toBeInTheDocument();
    expect(screen.getByTestId('weldcall-active-call')).toHaveTextContent('+31 612 345 678');
    expect(screen.getByTestId('weldcall-call-status')).toHaveTextContent('01:05');
    expect(screen.getByTestId('weldcall-waveform')).toHaveAttribute('data-mode', 'live');

    // The meeting header names the call and says it is being recorded
    const title = screen.getByText('Outbound Call to +31 612 345 678');
    const recording = screen.getByText('sweep.weldcrm.globalCallPanel.recording');
    expect(recording).toHaveAttribute('data-slot', 'badge');
    expect(title.compareDocumentPosition(recording) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Caller on top, waves in the middle, controls along the bottom like a meeting
    const [header, stage, controls] = ['weldcall-call-header', 'weldcall-call-stage', 'weldcall-controls'].map((id) =>
      screen.getByTestId(id),
    );
    expect(header).toHaveTextContent('+31 612 345 678');
    expect(stage).toContainElement(screen.getByTestId('weldcall-waveform'));
    expect(header.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stage.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls).toContainElement(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.endCall' }));

    fireEvent.click(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.mute' }));
    expect(callState.toggleMute).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.endCall' }));
    expect(callState.endCall).toHaveBeenCalled();
  });

  it('opens the call details and the people on the call from the header, one at a time', () => {
    callState.callState = activeCall();
    render(<NewCallPage />);

    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByTestId('weldcall-details-panel');
    expect(details).toHaveTextContent('Outbound Call to +31 612 345 678');
    expect(details).toHaveTextContent('+44 207 946 0123');
    expect(details).toHaveTextContent('01:05');
    expect(details).toHaveTextContent('Recorded');

    fireEvent.click(screen.getByTitle('People'));
    expect(screen.queryByTestId('weldcall-details-panel')).not.toBeInTheDocument();
    const people = screen.getByTestId('weldcall-people-panel');
    expect(people).toHaveTextContent('In this call (2)');
    expect(people).toHaveTextContent('You');
    expect(people).toHaveTextContent('+31 612 345 678');

    fireEvent.click(screen.getByTitle('People'));
    expect(screen.queryByTestId('weldcall-people-panel')).not.toBeInTheDocument();
  });

  it('offers the meeting timer under Tools, and none of the tools that need a meeting', () => {
    callState.callState = activeCall();
    render(<NewCallPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const timerRow = screen.getByRole('button', { name: /Timer/ });
    expect(screen.queryByText('Polls')).not.toBeInTheDocument();
    expect(screen.queryByText('Q&A')).not.toBeInTheDocument();
    expect(screen.queryByText('Record')).not.toBeInTheDocument();

    fireEvent.click(timerRow);
    expect(screen.getByRole('button', { name: 'Back to meeting tools' })).toBeInTheDocument();
    expect(screen.getByText('Only you see this countdown.')).toBeInTheDocument();

    // It runs on this call alone, with no meeting behind it
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('keeps the call controls off until the other side picks up', () => {
    callState.callState = activeCall({ status: 'ringing', duration: 0 });
    render(<NewCallPage />);

    expect(screen.getByTestId('weldcall-call-status')).toHaveTextContent('sweep.weldcrm.globalCallPanel.statusRinging');
    expect(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.mute' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.hold' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.endCall' })).toBeEnabled();
    expect(screen.getByTestId('weldcall-waveform')).toHaveAttribute('data-mode', 'flat');

    callState.toggleMute.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.mute' }));
    expect(callState.toggleMute).not.toHaveBeenCalled();
  });

  it('meters your microphone while you can be heard, and lets it go on mute', async () => {
    const stop = vi.fn();
    const micStream = { getTracks: () => [{ stop }], getAudioTracks: () => [{}] };
    const getUserMedia = vi.fn().mockResolvedValue(micStream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

    callState.callState = activeCall();
    const { rerender } = render(<NewCallPage />);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    callState.callState = activeCall({ isMuted: true });
    rerender(<NewCallPage />);
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('sends keypad presses during a call as tones', () => {
    callState.callState = activeCall();
    render(<NewCallPage />);

    fireEvent.click(screen.getByRole('button', { name: 'sweep.weldcrm.globalCallPanel.keypad' }));
    expect(screen.queryByTestId('weldcall-waveform')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    fireEvent.click(screen.getByRole('button', { name: '#' }));

    expect(callState.sendDigits).toHaveBeenNthCalledWith(1, '5');
    expect(callState.sendDigits).toHaveBeenNthCalledWith(2, '#');
    expect(screen.getByText('5#')).toBeInTheDocument();
  });
});
