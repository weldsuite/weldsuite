import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const clerk = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
}));
vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: clerk.user }),
  // The session is fresh in these tests: Clerk's confirmation never opens.
  useReverification: <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => fn,
}));
vi.mock('@clerk/clerk-react/errors', () => ({ isReverificationCancelledError: () => false }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { TwoFactorSection } from './two-factor-section';

function makeUser(totpEnabled: boolean) {
  return {
    totpEnabled,
    createTOTP: vi.fn(async () => ({ id: 'totp_1', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/WeldSuite:me?secret=JBSWY3DPEHPK3PXP', verified: false })),
    verifyTOTP: vi.fn(async () => ({ id: 'totp_1', verified: true, backupCodes: ['aaaa-1111', 'bbbb-2222'] })),
    disableTOTP: vi.fn(async () => ({})),
    createBackupCode: vi.fn(async () => ({ codes: ['cccc-3333'] })),
    reload: vi.fn(async () => undefined),
  };
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('TwoFactorSection', () => {
  it('sets up an authenticator app: QR code and key, the first code, then the backup codes', async () => {
    const user = userEvent.setup();
    const account = makeUser(false);
    clerk.user = account;
    renderWithProviders(<TwoFactorSection />);

    expect(screen.getByText('Off')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));

    const setup = await screen.findByRole('dialog', { name: 'Set up an authenticator app' });
    expect(within(setup).getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(setup.querySelector('svg')).not.toBeNull();

    await user.type(within(setup).getByLabelText('Code from the app'), '123 456');
    await user.click(within(setup).getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(account.verifyTOTP).toHaveBeenCalledWith({ code: '123456' }));
    const codes = await screen.findByRole('dialog', { name: 'Save your backup codes' });
    expect(within(codes).getByText('aaaa-1111')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Two-step verification is on.');
  });

  it('says so when the code is wrong, and keeps the setup open', async () => {
    const user = userEvent.setup();
    const account = makeUser(false);
    account.verifyTOTP.mockRejectedValueOnce({ errors: [{ code: 'form_code_incorrect' }] });
    clerk.user = account;
    renderWithProviders(<TwoFactorSection />);

    await user.click(screen.getByRole('button', { name: 'Set up' }));
    const setup = await screen.findByRole('dialog', { name: 'Set up an authenticator app' });
    await user.type(within(setup).getByLabelText('Code from the app'), '000000');
    await user.click(within(setup).getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That code is not right. Check the app and try again.'));
    expect(screen.getByRole('dialog', { name: 'Set up an authenticator app' })).toBeInTheDocument();
  });

  it('turns it off after confirming, and makes new backup codes', async () => {
    const user = userEvent.setup();
    const account = makeUser(true);
    clerk.user = account;
    renderWithProviders(<TwoFactorSection />);

    expect(screen.getByText('On')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New backup codes' }));
    expect(await screen.findByText('cccc-3333')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    const confirm = await screen.findByRole('dialog', { name: 'Turn off two-step verification?' });
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(account.disableTOTP).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Two-step verification is off.');
  });
});
