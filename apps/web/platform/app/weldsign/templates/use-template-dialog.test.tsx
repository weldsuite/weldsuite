import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { templates: { get: vi.fn(), use: vi.fn() } } }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@/lib/router', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));

import { UseTemplateDialog } from './use-template-dialog';

const tu = en.weldsign.templates.useTemplate;

function role(overrides: Partial<SignRecipientDto>): SignRecipientDto {
  return {
    id: 'sgr_client',
    role: 'signer',
    roleName: 'Client',
    name: null,
    email: null,
    personId: null,
    locale: 'en',
    routingOrder: 1,
    authMode: 'link',
    hasAccessCode: false,
    status: 'pending',
    sentAt: null,
    openedAt: null,
    signedAt: null,
    declinedAt: null,
    declineReason: null,
    lastRemindedAt: null,
    remindersSent: 0,
    ...overrides,
  };
}

/** Listed out of order on purpose: the dialog asks for the roles by routing order. */
const director = role({ id: 'sgr_director', roleName: 'Director', routingOrder: 2 });
const client = role({ id: 'sgr_client', roleName: 'Client', routingOrder: 1, name: 'Ann Client', email: 'ann@example.com', authMode: 'access_code' });
const accountant = role({ id: 'sgr_accountant', role: 'cc', roleName: 'Accountant', routingOrder: 3 });

function template(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgt_1',
    kind: 'template',
    title: 'Service agreement',
    status: 'draft',
    message: 'Please sign.',
    signingOrderEnabled: true,
    documents: [{ id: 'sgd_1', name: 'Agreement.pdf' }],
    recipientList: [director, client, accountant],
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <UseTemplateDialog templateId="sgt_1" onClose={onClose} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

const block = (name: string) => within(screen.getByRole('region', { name }));

async function loaded() {
  await screen.findByRole('region', { name: 'Client' });
}

beforeAll(() => {
  // Radix dialogs lean on pointer APIs jsdom lacks.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.weldsign.templates.get.mockReset();
  api.weldsign.templates.use.mockReset();
  router.push.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.templates.get.mockResolvedValue({ data: template() });
  api.weldsign.templates.use.mockResolvedValue({ data: { id: 'sgn_new' } });
});

afterEach(() => cleanup());

describe('UseTemplateDialog', () => {
  it('asks for every role in routing order, with the role\'s usual person filled in', async () => {
    renderDialog();
    await loaded();

    const names = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(names).toEqual(['Client', 'Director', 'Accountant']);

    expect(block('Client').getByLabelText(tu.name)).toHaveValue('Ann Client');
    expect(block('Client').getByLabelText(tu.email)).toHaveValue('ann@example.com');
    expect(block('Director').getByLabelText(tu.name)).toHaveValue('');
    expect(block('Director').getByLabelText(tu.email)).toHaveValue('');

    expect(block('Client').getByText('Step 1')).toBeInTheDocument();
    expect(block('Director').getByText('Step 2')).toBeInTheDocument();
    expect(block('Client').getByText(tu.signs)).toBeInTheDocument();
    expect(block('Accountant').getByText(tu.copy)).toBeInTheDocument();
  });

  it('prefills the title and message from the template', async () => {
    renderDialog();
    await loaded();
    expect(screen.getByLabelText(tu.requestTitle)).toHaveValue('Service agreement');
    expect(screen.getByLabelText(tu.message)).toHaveValue('Please sign.');
  });

  it('shows no step numbers when the template has no signing order', async () => {
    api.weldsign.templates.get.mockResolvedValue({ data: template({ signingOrderEnabled: false }) });
    renderDialog();
    await loaded();
    expect(screen.queryByText(/^Step \d/)).toBeNull();
  });

  it('asks for an access code only for a role that is protected with one', async () => {
    renderDialog();
    await loaded();
    expect(block('Client').getByLabelText(tu.accessCode)).toBeInTheDocument();
    expect(block('Director').queryByLabelText(tu.accessCode)).toBeNull();
    expect(block('Accountant').queryByLabelText(tu.accessCode)).toBeNull();
  });

  it('does not create the draft without an access code where one is needed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await loaded();
    await user.type(block('Director').getByLabelText(tu.name), 'Dora Director');
    await user.type(block('Director').getByLabelText(tu.email), 'dora@example.com');
    await user.type(block('Accountant').getByLabelText(tu.name), 'Cas Accountant');
    await user.type(block('Accountant').getByLabelText(tu.email), 'cas@example.com');

    await user.click(screen.getByRole('button', { name: tu.submit }));

    expect(await screen.findByText(tu.accessCodeRequired)).toBeInTheDocument();
    expect(api.weldsign.templates.use).not.toHaveBeenCalled();

    // Too short counts as missing.
    await user.type(block('Client').getByLabelText(tu.accessCode), 'abc');
    await user.click(screen.getByRole('button', { name: tu.submit }));
    expect(await screen.findByText(tu.accessCodeRequired)).toBeInTheDocument();
    expect(api.weldsign.templates.use).not.toHaveBeenCalled();
  });

  it('creates the draft, closes, and opens it on its Review step', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await loaded();
    await user.type(block('Client').getByLabelText(tu.accessCode), '4821');
    await user.type(block('Director').getByLabelText(tu.name), 'Dora Director');
    await user.type(block('Director').getByLabelText(tu.email), 'Dora@Example.com');
    await user.type(block('Accountant').getByLabelText(tu.name), 'Cas Accountant');
    await user.type(block('Accountant').getByLabelText(tu.email), 'cas@example.com');

    await user.click(screen.getByRole('button', { name: tu.submit }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldsign/sgn_new?step=review'));
    expect(onClose).toHaveBeenCalled();
    // Roles go out in routing order; title and message are left to the template; a code goes with the protected role only.
    expect(api.weldsign.templates.use).toHaveBeenCalledWith('sgt_1', {
      title: undefined,
      message: undefined,
      recipients: [
        { roleId: 'sgr_client', name: 'Ann Client', email: 'ann@example.com', accessCode: '4821' },
        { roleId: 'sgr_director', name: 'Dora Director', email: 'dora@example.com', accessCode: undefined },
        { roleId: 'sgr_accountant', name: 'Cas Accountant', email: 'cas@example.com', accessCode: undefined },
      ],
    });
  });

  it('sends a changed title, and a cleared message as null', async () => {
    const user = userEvent.setup();
    renderDialog();
    await loaded();
    await user.type(block('Client').getByLabelText(tu.accessCode), '4821');
    await user.type(block('Director').getByLabelText(tu.name), 'Dora');
    await user.type(block('Director').getByLabelText(tu.email), 'dora@example.com');
    await user.type(block('Accountant').getByLabelText(tu.name), 'Cas');
    await user.type(block('Accountant').getByLabelText(tu.email), 'cas@example.com');
    await user.clear(screen.getByLabelText(tu.requestTitle));
    await user.type(screen.getByLabelText(tu.requestTitle), 'Agreement for Acme');
    await user.clear(screen.getByLabelText(tu.message));

    await user.click(screen.getByRole('button', { name: tu.submit }));

    await waitFor(() => expect(api.weldsign.templates.use).toHaveBeenCalled());
    expect(api.weldsign.templates.use.mock.calls[0]![1]).toMatchObject({ title: 'Agreement for Acme', message: null });
  });

  it('refuses a missing name or an invalid email without calling the server', async () => {
    const user = userEvent.setup();
    renderDialog();
    await loaded();
    await user.type(block('Client').getByLabelText(tu.accessCode), '4821');
    await user.type(block('Director').getByLabelText(tu.email), 'not-an-email');

    await user.click(screen.getByRole('button', { name: tu.submit }));

    expect((await screen.findAllByText(tu.nameRequired)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(tu.invalidEmail).length).toBeGreaterThan(0);
    expect(api.weldsign.templates.use).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('refuses one email address for two roles', async () => {
    const user = userEvent.setup();
    renderDialog();
    await loaded();
    await user.type(block('Client').getByLabelText(tu.accessCode), '4821');
    await user.type(block('Director').getByLabelText(tu.name), 'Dora');
    await user.type(block('Director').getByLabelText(tu.email), 'ANN@example.com');
    await user.type(block('Accountant').getByLabelText(tu.name), 'Cas');
    await user.type(block('Accountant').getByLabelText(tu.email), 'cas@example.com');

    await user.click(screen.getByRole('button', { name: tu.submit }));

    expect(await screen.findByText(tu.duplicateEmail)).toBeInTheDocument();
    expect(block('Director').getByText(tu.duplicateEmail)).toBeInTheDocument();
    expect(api.weldsign.templates.use).not.toHaveBeenCalled();
  });

  it('shows the server\'s message when it refuses, and stays open', async () => {
    api.weldsign.templates.use.mockRejectedValue(new ApiError('Role Director is missing', 400));
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await loaded();
    await user.type(block('Client').getByLabelText(tu.accessCode), '4821');
    await user.type(block('Director').getByLabelText(tu.name), 'Dora');
    await user.type(block('Director').getByLabelText(tu.email), 'dora@example.com');
    await user.type(block('Accountant').getByLabelText(tu.name), 'Cas');
    await user.type(block('Accountant').getByLabelText(tu.email), 'cas@example.com');

    await user.click(screen.getByRole('button', { name: tu.submit }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${tu.failed}: Role Director is missing`));
    expect(router.push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: tu.submit })).toBeEnabled();
  });

  it('closes on Cancel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await loaded();
    await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
    expect(onClose).toHaveBeenCalled();
  });

  it('cannot be submitted for a template without a document', async () => {
    api.weldsign.templates.get.mockResolvedValue({ data: template({ documents: [] }) });
    renderDialog();
    expect(await screen.findByText(en.weldsign.templates.cannotUse)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tu.submit })).toBeDisabled();
  });

  it('cannot be submitted for a template without a role', async () => {
    api.weldsign.templates.get.mockResolvedValue({ data: template({ recipientList: [] }) });
    renderDialog();
    expect(await screen.findByText(en.weldsign.templates.cannotUse)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tu.submit })).toBeDisabled();
  });

  it('says so when the template cannot be loaded', async () => {
    api.weldsign.templates.get.mockRejectedValue(new ApiError('Not found', 404));
    renderDialog();
    expect(await screen.findByText(tu.loadFailed)).toBeInTheDocument();
  });

  it('stays closed without a template', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">
          <UseTemplateDialog templateId={null} onClose={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.weldsign.templates.get).not.toHaveBeenCalled();
  });
});
