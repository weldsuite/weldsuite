import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('@/lib/i18n/provider', async () => {
  const locale = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale.en, language: 'en', format: interpolate }) };
});

const mocks = vi.hoisted(() => ({
  callback: { mutate: vi.fn() },
  select: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorOAuthCallback: () => mocks.callback,
  useSelectConnectorAccount: () => mocks.select,
}));

import { ConnectorCallback } from './connector-callback';

const tc = en.settings.integrations.connectors;
const assign = vi.fn();

type CallbackOptions = { onSuccess: (r: unknown) => void; onError: (e: unknown) => void };

function callbackOptions(): CallbackOptions {
  return mocks.callback.mutate.mock.calls[0][1] as CallbackOptions;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.select.isPending = false;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, origin: 'http://localhost:3000', pathname: '/settings/integrations/callback', search: '' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const admins = [
  { id: 'a1', name: 'First BV', currency: 'EUR' },
  { id: 'a2', name: 'Second BV' },
];

function picker() {
  render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
  act(() => {
    callbackOptions().onSuccess({
      data: {
        needsPicker: true,
        connection: { id: 'cc_9' },
        administrations: admins,
        returnUrl: 'http://localhost:3000/settings/integrations/moneybird',
      },
    });
  });
}

describe('ConnectorCallback', () => {
  it('says access was denied when the provider returned an error', () => {
    render(<ConnectorCallback code={undefined} state={undefined} error="access_denied" />);
    expect(screen.getByText(tc.authDenied)).toBeInTheDocument();
    expect(mocks.callback.mutate).not.toHaveBeenCalled();
  });

  it('says the callback is incomplete without a code or state', () => {
    render(<ConnectorCallback code="c" state={undefined} error={undefined} />);
    expect(screen.getByText(tc.callbackMissingParamsGeneric)).toBeInTheDocument();
    expect(mocks.callback.mutate).not.toHaveBeenCalled();
  });

  it('goes back to the integrations list from the error screen', () => {
    render(<ConnectorCallback code={undefined} state="s" error={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: tc.title }));
    expect(assign).toHaveBeenCalledWith('/settings/integrations');
  });

  it('shows the Moneybird progress while the code is exchanged', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    expect(mocks.callback.mutate).toHaveBeenCalledWith({ provider: 'moneybird', code: 'c', state: 'mb_s' }, expect.any(Object));
    expect(screen.getByText(tc.callbackConnecting)).toBeInTheDocument();
    expect(screen.getByText(tc.callbackConnectingHint)).toBeInTheDocument();
  });

  it('shows the Stripe progress for a Stripe state', () => {
    render(<ConnectorCallback code="c" state="stripe_s" error={undefined} />);
    expect(mocks.callback.mutate.mock.calls[0][0].provider).toBe('stripe');
    expect(screen.getByText(tc.callbackConnectingStripe)).toBeInTheDocument();
    expect(screen.getByText(tc.callbackConnectingHintStripe)).toBeInTheDocument();
  });

  it('exchanges the code only once', () => {
    const { rerender } = render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    rerender(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    expect(mocks.callback.mutate).toHaveBeenCalledTimes(1);
  });

  it('forgets the recorded flow once the callback starts', () => {
    sessionStorage.setItem('integrations_oauth_flow', '{"kind":"connector"}');
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    expect(sessionStorage.getItem('integrations_oauth_flow')).toBeNull();
  });

  it('returns to the page the flow started from after a short pause', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    act(() => {
      callbackOptions().onSuccess({
        data: { needsPicker: false, returnUrl: 'http://localhost:3000/settings/integrations/stripe?x=1' },
      });
    });
    expect(screen.getByText(tc.connected)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(assign).toHaveBeenCalledWith('/settings/integrations/stripe?x=1');
  });

  it('returns to the integrations list when no return URL came back', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    act(() => {
      callbackOptions().onSuccess({ data: { needsPicker: false } });
      vi.advanceTimersByTime(1200);
    });
    expect(assign).toHaveBeenCalledWith('/settings/integrations');
  });

  it('shows the error message when the exchange fails', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    act(() => callbackOptions().onError(new Error('Token rejected')));
    expect(screen.getByText('Token rejected')).toBeInTheDocument();
  });

  it('shows a generic message when the failure has no message', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    act(() => callbackOptions().onError('boom'));
    expect(screen.getAllByText(tc.connectFailed).length).toBeGreaterThan(0);
  });
});

describe('ConnectorCallback administration picker', () => {
  it('lists the administrations with the first one selected', () => {
    picker();
    expect(screen.getByText(tc.pickAdministration)).toBeInTheDocument();
    expect(screen.getByText('First BV')).toBeInTheDocument();
    expect(screen.getByText('EUR')).toBeInTheDocument();
    expect(screen.getByText('Second BV')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.select.mutate).toHaveBeenCalledWith({ connectionId: 'cc_9', administrationId: 'a1' }, expect.any(Object));
  });

  it('connects the administration that was picked, then returns', () => {
    picker();
    fireEvent.click(screen.getByText('Second BV'));
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    expect(mocks.select.mutate).toHaveBeenCalledWith({ connectionId: 'cc_9', administrationId: 'a2' }, expect.any(Object));
    const options = mocks.select.mutate.mock.calls[0][1] as CallbackOptions;
    act(() => options.onSuccess(undefined));
    expect(screen.getByText(tc.connected)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(assign).toHaveBeenCalledWith('/settings/integrations/moneybird');
  });

  it('shows the error when choosing the administration fails', () => {
    picker();
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    const options = mocks.select.mutate.mock.calls[0][1] as CallbackOptions;
    act(() => options.onError(new Error('Not yours')));
    expect(screen.getByText('Not yours')).toBeInTheDocument();
    // The error screen's button leads back to where the flow started.
    fireEvent.click(screen.getByRole('button', { name: tc.title }));
    expect(assign).toHaveBeenCalledWith('/settings/integrations/moneybird');
  });

  it('falls back to a generic message for an error without a message', () => {
    picker();
    fireEvent.click(screen.getByRole('button', { name: tc.connect }));
    const options = mocks.select.mutate.mock.calls[0][1] as CallbackOptions;
    act(() => options.onError(42));
    expect(screen.getAllByText(tc.connectFailed).length).toBeGreaterThan(0);
  });

  it('cannot connect when the account has no administrations', () => {
    render(<ConnectorCallback code="c" state="mb_s" error={undefined} />);
    act(() => {
      callbackOptions().onSuccess({ data: { needsPicker: true, connection: { id: 'cc_9' }, administrations: [] } });
    });
    expect(screen.getByRole('button', { name: tc.connect })).toBeDisabled();
  });

  it('disables connect while the choice is being saved', () => {
    mocks.select.isPending = true;
    picker();
    expect(screen.getByRole('button', { name: tc.connect })).toBeDisabled();
  });
});
