import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { ApiKeyDialog } from './api-key-dialog';

// Twilio's catalog entry: what the WeldConnect page never asked for, so it could not connect.
const TWILIO_FIELDS = [
  { key: 'accountSid', label: 'Account SID', placeholder: 'ACxxxxxxxx' },
  { key: 'authToken', label: 'Auth Token', secret: true },
  { key: 'fromNumber', label: 'Default From number', placeholder: '+15551234567' },
];

function renderDialog(onSubmit = vi.fn()) {
  render(
    <ApiKeyDialog open onOpenChange={vi.fn()} providerName="Twilio" fields={TWILIO_FIELDS} pending={false} onSubmit={onSubmit} />,
  );
  return onSubmit;
}

describe('ApiKeyDialog', () => {
  it('asks for every credential the provider lists, the secret ones masked', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Connect Twilio' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account SID')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Auth Token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Default From number')).toBeRequired();
  });

  it('says what is missing on submit and sends nothing', async () => {
    const onSubmit = renderDialog();
    fireEvent.change(screen.getByLabelText('Account SID'), { target: { value: 'AC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Enter the Auth Token.')).toBeInTheDocument();
    expect(screen.getByLabelText('Auth Token')).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the trimmed credentials', async () => {
    const onSubmit = renderDialog();
    fireEvent.change(screen.getByLabelText('Account SID'), { target: { value: ' AC123 ' } });
    fireEvent.change(screen.getByLabelText('Auth Token'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Default From number'), { target: { value: '+31612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ accountSid: 'AC123', authToken: 'secret', fromNumber: '+31612345678' }),
    );
  });
});
