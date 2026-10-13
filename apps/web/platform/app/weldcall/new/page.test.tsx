import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const navigate = vi.fn();
const callState = {
  phoneNumbers: [] as Array<{ id: string }>,
  isDialerOpen: false,
  callState: null as { status: string } | null,
  isMinimized: false,
  setIsDialerOpen: vi.fn(),
  setInitialDialerNumber: vi.fn(),
};

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
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

  it('makes room for the open dialer instead of sitting under it', () => {
    const { rerender } = render(<NewCallPage />);
    expect(screen.getByTestId('weldcall-landing').className).not.toContain('@3xl:pr-[372px]');

    callState.isDialerOpen = true;
    rerender(<NewCallPage />);
    expect(screen.getByTestId('weldcall-landing').className).toContain('@3xl:pr-[372px]');
  });

  it('gives the space back when a call is minimized to the small bar', () => {
    callState.callState = { status: 'connected' };
    callState.isMinimized = true;
    render(<NewCallPage />);
    expect(screen.getByTestId('weldcall-landing').className).not.toContain('@3xl:pr-[372px]');
  });
});
