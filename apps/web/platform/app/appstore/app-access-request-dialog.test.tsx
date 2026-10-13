import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import { WELDREACH_TERMS, WELDREACH_TERMS_VERSION } from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  appAccess: { get: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { fullName: 'Anna de Vries', primaryEmailAddress: { emailAddress: 'anna@acme.test' } } }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AppAccessRequestDialog } from './app-access-request-dialog';

function renderDialog(onOpenChange = vi.fn(), onSubmitted = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <AppAccessRequestDialog
          app={{ code: 'weldreach', name: 'WeldReach' }}
          open
          onOpenChange={onOpenChange}
          onSubmitted={onSubmitted}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange, onSubmitted };
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.appAccess.get.mockReset();
  api.appAccess.request.mockReset();
  api.appAccess.get.mockResolvedValue({ data: null });
  api.appAccess.request.mockResolvedValue({ data: { status: 'requested' } });
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Company legal name'), 'Acme B.V.');
  await user.type(screen.getByLabelText('Website'), 'https://acme.test');
  await user.type(screen.getByLabelText('What will you use WeldReach for?'), 'We sell payroll software to Dutch accountants.');
  await user.type(screen.getByLabelText('Expected emails per day'), '150');
}

async function pickCountry(user: ReturnType<typeof userEvent.setup>, search: string, name: RegExp) {
  const field = screen.getByRole('combobox', { name: 'Countries you will email' });
  await user.click(field);
  await user.type(field, search);
  await user.click(await screen.findByRole('option', { name }));
}

describe('AppAccessRequestDialog', () => {
  it('prefills the contact from the signed-in user', () => {
    renderDialog();
    expect(screen.getByLabelText('Contact person')).toHaveValue('Anna de Vries');
    expect(screen.getByLabelText('Contact email')).toHaveValue('anna@acme.test');
  });

  it('does not send an empty request and says what is missing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThan(0);
    expect(screen.getByText('Tick every statement to continue.')).toBeInTheDocument();
    expect(api.appAccess.request).not.toHaveBeenCalled();
  });

  it('shows the consent notice for the Netherlands and Germany only', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByText(/requires prior consent/)).not.toBeInTheDocument();

    await pickCountry(user, 'Belg', /Belgium/);
    expect(screen.queryByText(/requires prior consent/)).not.toBeInTheDocument();

    await pickCountry(user, 'Nether', /Netherlands/);
    expect(await screen.findByText(/requires prior consent/)).toBeInTheDocument();
  });

  it('files the request with the terms version and every term ticked', async () => {
    const user = userEvent.setup();
    const { onSubmitted, onOpenChange } = renderDialog();
    await fillForm(user);
    await pickCountry(user, 'Nether', /Netherlands/);
    for (const checkbox of screen.getAllByRole('checkbox')) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(api.appAccess.request).toHaveBeenCalledTimes(1));
    const [code, body] = api.appAccess.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(code).toBe('weldreach');
    expect(body).toMatchObject({
      companyName: 'Acme B.V.',
      contactEmail: 'anna@acme.test',
      expectedDailySends: 150,
      targetCountries: ['NL'],
      listSource: 'own_research',
      termsVersion: WELDREACH_TERMS_VERSION,
    });
    expect([...(body.termsAccepted as string[])].sort()).toEqual([...WELDREACH_TERMS].sort());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Request sent. We will get back to you by email.');
  });

  it('refuses a request with one term left unticked', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillForm(user);
    await pickCountry(user, 'Nether', /Netherlands/);
    const boxes = screen.getAllByRole('checkbox');
    for (const checkbox of boxes.slice(0, -1)) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('Tick every statement to continue.')).toBeInTheDocument();
    expect(api.appAccess.request).not.toHaveBeenCalled();
  });

  it('explains a 409: a request is already pending', async () => {
    api.appAccess.request.mockRejectedValue(new ApiError('conflict', 409, { error: { code: 'CONFLICT' } }));
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await fillForm(user);
    await pickCountry(user, 'Nether', /Netherlands/);
    for (const checkbox of screen.getAllByRole('checkbox')) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A request for this workspace is already pending.'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
