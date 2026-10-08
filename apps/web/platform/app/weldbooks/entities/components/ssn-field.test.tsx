import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  reveal: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { revealEntitySsn: mocks.reveal } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { SSN_REVEAL_SECONDS, SsnField } from './ssn-field';

let latest = { ssn: '', clearSsn: false };

function Harness(props: Readonly<{ hasSsn: boolean; canReveal: boolean; entityId?: string; error?: string }>) {
  const [state, setState] = useState({ ssn: '', clearSsn: false });
  latest = state;
  return (
    <SsnField
      id="ssn"
      entityId={props.entityId ?? 'ent_1'}
      hasSsn={props.hasSsn}
      last4="6789"
      value={state.ssn}
      clearSsn={state.clearSsn}
      error={props.error}
      canReveal={props.canReveal}
      onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
    />
  );
}

describe('SsnField', () => {
  beforeEach(() => {
    mocks.reveal.mockReset();
    mocks.toastError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a write-only input, formatted as XXX-XX-XXXX, while no SSN is stored', async () => {
    const user = userEvent.setup();
    render(<Harness hasSsn={false} canReveal />);

    const input = screen.getByLabelText('Social Security number');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    await user.type(input, '123456789');
    expect(latest.ssn).toBe('123-45-6789');
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument();
  });

  it('shows only the last four digits of a stored SSN', () => {
    render(<Harness hasSsn canReveal={false} />);
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
    expect(screen.getByText('Stored encrypted')).toBeInTheDocument();
    // Without tax_ids:reveal there is no way to see the rest.
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument();
  });

  it('reveals the full number on an explicit click and hides it again', async () => {
    const user = userEvent.setup();
    mocks.reveal.mockResolvedValue({ data: { ssn: '123-45-6789' } });
    render(<Harness hasSsn canReveal />);

    expect(mocks.reveal).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reveal' }));

    expect(mocks.reveal).toHaveBeenCalledWith('ent_1');
    expect(await screen.findByText('123-45-6789')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`Hides again in ${SSN_REVEAL_SECONDS} seconds`);

    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('123-45-6789')).not.toBeInTheDocument();
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
  });

  it('hides a revealed SSN by itself after 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.reveal.mockResolvedValue({ data: { ssn: '123-45-6789' } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness hasSsn canReveal />);

    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('123-45-6789')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync((SSN_REVEAL_SECONDS - 1) * 1000);
    });
    expect(screen.getByText('123-45-6789')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(screen.queryByText('123-45-6789')).not.toBeInTheDocument());
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
  });

  it('drops a reveal that is answered after the user left the entity', async () => {
    const user = userEvent.setup();
    let resolve: (value: { data: { ssn: string } }) => void = () => {};
    mocks.reveal.mockReturnValue(new Promise((r) => (resolve = r)));
    const { rerender } = render(<Harness hasSsn canReveal entityId="ent_1" />);

    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    rerender(<Harness hasSsn canReveal entityId="ent_2" />);
    await act(async () => {
      resolve({ data: { ssn: '123-45-6789' } });
    });
    expect(screen.queryByText('123-45-6789')).not.toBeInTheDocument();
  });

  it('reports a failed reveal without showing anything', async () => {
    const user = userEvent.setup();
    mocks.reveal.mockRejectedValue(new Error('Forbidden'));
    render(<Harness hasSsn canReveal />);
    await user.click(screen.getByRole('button', { name: 'Reveal' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not reveal the SSN', { description: 'Forbidden' }));
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
  });

  it('replaces a stored SSN with a new one, or removes it', async () => {
    const user = userEvent.setup();
    render(<Harness hasSsn canReveal={false} />);

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Social Security number'), '987654321');
    expect(latest.ssn).toBe('987-65-4321');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(latest.ssn).toBe('');
    expect(screen.getByTestId('ssn-display')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(latest.clearSsn).toBe(true);
    expect(screen.getByText('The SSN is removed when you save.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(latest.clearSsn).toBe(false);
  });

  it('shows the validation error', () => {
    render(<Harness hasSsn={false} canReveal={false} error="Enter a valid Social Security number (XXX-XX-XXXX)" />);
    expect(screen.getByText('Enter a valid Social Security number (XXX-XX-XXXX)')).toBeInTheDocument();
  });
});
