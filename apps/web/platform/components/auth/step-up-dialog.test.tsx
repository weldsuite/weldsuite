/**
 * "Confirm it's you" (ADR SEC-022): the API clients' refusals wait on this
 * dialog, which has the provider confirm the person's identity again.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepUpChallenge } from '@weldsuite/api-client/step-up';
import { confirmStepUp } from '@/lib/api/step-up';
import { StepUpError } from '@/lib/auth/oidc/step-up-error';
import { StepUpDialogHost, strongerChallenge } from './step-up-dialog';

const auth = vi.hoisted(() => ({ canStepUp: vi.fn(() => true), stepUp: vi.fn() }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  canStepUp: auth.canStepUp,
  stepUp: auth.stepUp,
}));

const secondFactor: StepUpChallenge = { code: 'REVERIFICATION_REQUIRED', level: 'second_factor', afterMinutes: 10 };
const signIn: StepUpChallenge = { code: 'REVERIFICATION_REQUIRED', level: 'first_factor', afterMinutes: 10 };

afterEach(() => {
  auth.canStepUp.mockReturnValue(true);
  auth.stepUp.mockReset();
});

describe('StepUpDialogHost', () => {
  it('has the person confirm, then lets every waiting request go out again', async () => {
    auth.stepUp.mockResolvedValue(undefined);
    render(<StepUpDialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmStepUp(signIn);
      second = confirmStepUp(secondFactor);
    });
    expect(await screen.findByText("Confirm it's you")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // One confirmation, at the strongest level asked for.
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(auth.stepUp).toHaveBeenCalledTimes(1);
    expect(auth.stepUp).toHaveBeenCalledWith('second_factor');
    await waitFor(() => expect(screen.queryByText("Confirm it's you")).toBeNull());
  });

  it('stays open when the sign-in window is closed, and refuses on Cancel', async () => {
    auth.stepUp.mockRejectedValue(new StepUpError('cancelled'));
    render(<StepUpDialogHost />);
    let waiting!: Promise<boolean>;
    act(() => {
      waiting = confirmStepUp(secondFactor);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The sign-in window was closed before you confirmed. Try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(waiting).resolves.toBe(false);
  });

  it('refuses, without asking again, when someone else signed in', async () => {
    auth.stepUp.mockRejectedValue(new StepUpError('other_account'));
    render(<StepUpDialogHost />);
    let waiting!: Promise<boolean>;
    act(() => {
      waiting = confirmStepUp(signIn);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await expect(waiting).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByText("Confirm it's you")).toBeNull());
  });

  it('says it failed and stays open when the provider fails', async () => {
    auth.stepUp.mockRejectedValue(new Error('network'));
    render(<StepUpDialogHost />);
    act(() => {
      void confirmStepUp(secondFactor);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe("We couldn't confirm your identity. Try again.");
  });

  it('refuses what was waiting when it goes away', async () => {
    const { unmount } = render(<StepUpDialogHost />);
    let waiting!: Promise<boolean>;
    act(() => {
      waiting = confirmStepUp(secondFactor);
    });
    await screen.findByText("Confirm it's you");
    unmount();
    await expect(waiting).resolves.toBe(false);
  });

  it('asks a person without a second factor to set one up', async () => {
    render(<StepUpDialogHost />);
    act(() => {
      void confirmStepUp({ code: 'MFA_REQUIRED', level: 'second_factor', afterMinutes: null });
    });
    expect(await screen.findByText('Set up two-step verification')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy();
  });

  it('asks nothing where the provider cannot (Clerk)', async () => {
    auth.canStepUp.mockReturnValue(false);
    render(<StepUpDialogHost />);
    await expect(confirmStepUp(secondFactor)).resolves.toBe(false);
  });
});

describe('strongerChallenge', () => {
  it('prefers setting up a second factor, then confirming one', () => {
    expect(strongerChallenge(signIn, secondFactor).level).toBe('second_factor');
    expect(strongerChallenge(signIn, signIn).level).toBe('first_factor');
    expect(strongerChallenge(secondFactor, { code: 'MFA_REQUIRED', level: 'second_factor', afterMinutes: null }).code).toBe(
      'MFA_REQUIRED',
    );
  });
});
