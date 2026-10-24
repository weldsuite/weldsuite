import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({
  weldsign: { templates: { addRole: vi.fn(), updateRole: vi.fn(), removeRole: vi.fn(), update: vi.fn() } },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('sonner', () => ({ toast }));

import { RolesStep } from './roles-step';

const tr = en.weldsign.templates.roles;
const re = en.weldsign.editor.recipients;

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

const client = role({ id: 'sgr_client', roleName: 'Client', name: 'Ann Client', email: 'ann@example.com' });
const director = role({ id: 'sgr_director', roleName: 'Director', routingOrder: 2, authMode: 'access_code' });
const accountant = role({ id: 'sgr_accountant', role: 'cc', roleName: 'Accountant', routingOrder: 3 });

function template(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgt_1',
    kind: 'template',
    title: 'Service agreement',
    status: 'draft',
    signingOrderEnabled: false,
    documents: [],
    recipientList: [client, director, accountant],
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(detail: SignEnvelopeDetail, editable = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <RolesStep template={detail} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const nameInput = (roleName: string) => screen.getByDisplayValue(roleName);

beforeAll(() => {
  // Radix selects and dialogs lean on pointer APIs jsdom lacks.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  for (const fn of Object.values(api.weldsign.templates)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.templates.updateRole.mockResolvedValue({ data: client });
  api.weldsign.templates.addRole.mockResolvedValue({ data: client });
  api.weldsign.templates.removeRole.mockResolvedValue(undefined);
  api.weldsign.templates.update.mockResolvedValue({ data: template() });
});

afterEach(() => cleanup());

describe('RolesStep', () => {
  it('lists the roles with their usual person', () => {
    renderStep(template());
    expect(nameInput('Client')).toBeInTheDocument();
    expect(nameInput('Director')).toBeInTheDocument();
    expect(nameInput('Accountant')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ann Client')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ann@example.com')).toBeInTheDocument();
  });

  it('says when there are no roles', () => {
    renderStep(template({ recipientList: [] }));
    expect(screen.getByText(tr.empty)).toBeInTheDocument();
  });

  it('asks for the identity check of signers only, and explains that the access code comes later', () => {
    renderStep(template());
    // Client and Director sign; the accountant only gets a copy.
    expect(screen.getAllByRole('combobox', { name: re.verification })).toHaveLength(2);
    expect(screen.getAllByText(tr.accessCodeNote)).toHaveLength(1);
    expect(screen.queryByLabelText(re.accessCode)).toBeNull();
  });

  describe('role name', () => {
    it('is saved when the field loses focus', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(nameInput('Client'));
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#role-sgr_client-name' }), 'Customer');
      await user.tab();
      await waitFor(() => expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { roleName: 'Customer' }));
    });

    it('cannot be blank', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(nameInput('Client'));
      await user.tab();
      expect(toast.error).toHaveBeenCalledWith(tr.roleNameRequired);
      expect(api.weldsign.templates.updateRole).not.toHaveBeenCalled();
      expect(nameInput('Client')).toBeInTheDocument();
    });

    it('cannot be the name of another role, whatever the case', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(nameInput('Client'));
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#role-sgr_client-name' }), 'director');
      await user.tab();
      expect(toast.error).toHaveBeenCalledWith('There is already a role called "director"');
      expect(api.weldsign.templates.updateRole).not.toHaveBeenCalled();
      expect(nameInput('Client')).toBeInTheDocument();
    });

    it('goes back to the old name, with the server\'s reason, when the server refuses', async () => {
      api.weldsign.templates.updateRole.mockRejectedValue(new ApiError('A role with this name exists', 400));
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(nameInput('Client'));
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#role-sgr_client-name' }), 'Customer');
      await user.tab();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save Client: A role with this name exists'));
      await waitFor(() => expect(nameInput('Client')).toBeInTheDocument());
    });
  });

  describe('usual name and email', () => {
    it('saves a cleared name as no default', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(screen.getByDisplayValue('Ann Client'));
      await user.tab();
      await waitFor(() => expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { name: null }));
    });

    it('saves a cleared email as no default', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(screen.getByDisplayValue('ann@example.com'));
      await user.tab();
      await waitFor(() => expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { email: null }));
    });

    it('saves an email lower-cased', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(screen.getByDisplayValue('ann@example.com'));
      await user.type(document.getElementById('role-sgr_client-default-email')!, 'Ann.New@Example.com');
      await user.tab();
      await waitFor(() =>
        expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { email: 'ann.new@example.com' }),
      );
    });

    it('refuses an invalid email and puts the old one back', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.clear(screen.getByDisplayValue('ann@example.com'));
      await user.type(document.getElementById('role-sgr_client-default-email')!, 'nope');
      await user.tab();
      expect(toast.error).toHaveBeenCalledWith(tr.invalidEmail);
      expect(api.weldsign.templates.updateRole).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('ann@example.com')).toBeInTheDocument();
    });
  });

  describe('type and identity check', () => {
    async function choose(user: ReturnType<typeof userEvent.setup>, index: number, label: string, option: string) {
      await user.click(screen.getAllByRole('combobox', { name: label })[index]!);
      await user.click(await screen.findByRole('option', { name: option }));
    }

    it('turns a signer into a copy recipient and drops its identity check', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await choose(user, 0, tr.type, re.roles.cc);
      await waitFor(() =>
        expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { role: 'cc', authMode: 'link' }),
      );
    });

    it('saves the access code mode at once: the code itself is asked when the template is used', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await choose(user, 0, re.verification, re.authModes.access_code);
      await waitFor(() =>
        expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { authMode: 'access_code' }),
      );
    });

    it('saves the language', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await choose(user, 0, re.language, re.languages.nl);
      await waitFor(() => expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { locale: 'nl' }));
    });
  });

  describe('adding a role', () => {
    it('adds a role that signs, in the language of the interface', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#new-role-name' }), 'Witness');
      await user.click(screen.getByRole('button', { name: tr.add }));
      await waitFor(() =>
        expect(api.weldsign.templates.addRole).toHaveBeenCalledWith('sgt_1', { roleName: 'Witness', role: 'signer', locale: 'en' }),
      );
      await waitFor(() => expect(screen.getByLabelText(tr.roleName, { selector: '#new-role-name' })).toHaveValue(''));
    });

    it('needs a name', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.click(screen.getByRole('button', { name: tr.add }));
      expect(toast.error).toHaveBeenCalledWith(tr.roleNameRequired);
      expect(api.weldsign.templates.addRole).not.toHaveBeenCalled();
    });

    it('refuses a name that is taken', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#new-role-name' }), ' CLIENT ');
      await user.click(screen.getByRole('button', { name: tr.add }));
      expect(toast.error).toHaveBeenCalledWith('There is already a role called "CLIENT"');
      expect(api.weldsign.templates.addRole).not.toHaveBeenCalled();
    });

    it('shows the server\'s message when it refuses', async () => {
      api.weldsign.templates.addRole.mockRejectedValue(new ApiError('A template can have at most 50 roles', 400));
      const user = userEvent.setup();
      renderStep(template());
      await user.type(screen.getByLabelText(tr.roleName, { selector: '#new-role-name' }), 'Witness');
      await user.click(screen.getByRole('button', { name: tr.add }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A template can have at most 50 roles'));
    });
  });

  describe('signing order', () => {
    it('is switched on and off for the whole template', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.click(screen.getByRole('switch'));
      await waitFor(() => expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { signingOrderEnabled: true }));
    });

    it('shows no order, and nothing to move, while it is off', () => {
      renderStep(template());
      expect(screen.queryByRole('button', { name: re.order })).toBeNull();
      expect(screen.queryByRole('button', { name: en.weldsign.editor.documents.moveUp })).toBeNull();
    });

    it('numbers the roles and swaps two of them when one is moved', async () => {
      const user = userEvent.setup();
      renderStep(template({ signingOrderEnabled: true }));
      expect(screen.getAllByLabelText(re.order).map((el) => el.textContent)).toEqual(['1', '2', '3']);

      const down = screen.getAllByRole('button', { name: en.weldsign.editor.documents.moveDown });
      await user.click(down[0]!);

      await waitFor(() => expect(api.weldsign.templates.updateRole).toHaveBeenCalledTimes(2));
      expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_client', { routingOrder: 2 });
      expect(api.weldsign.templates.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_director', { routingOrder: 1 });
    });

    it('cannot move the first role up or the last role down', () => {
      renderStep(template({ signingOrderEnabled: true }));
      expect(screen.getAllByRole('button', { name: en.weldsign.editor.documents.moveUp })[0]).toBeDisabled();
      expect(screen.getAllByRole('button', { name: en.weldsign.editor.documents.moveDown }).at(-1)).toBeDisabled();
    });
  });

  describe('removing a role', () => {
    it('asks first, and says its fields go too', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.click(screen.getByRole('button', { name: `${tr.remove}: Client` }));
      expect(screen.getByText('The fields placed for "Client" are removed too.')).toBeInTheDocument();
      expect(api.weldsign.templates.removeRole).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: tr.remove }));
      await waitFor(() => expect(api.weldsign.templates.removeRole).toHaveBeenCalledWith('sgt_1', 'sgr_client'));
    });

    it('keeps the role when the question is cancelled', async () => {
      const user = userEvent.setup();
      renderStep(template());
      await user.click(screen.getByRole('button', { name: `${tr.remove}: Director` }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(api.weldsign.templates.removeRole).not.toHaveBeenCalled();
    });
  });

  describe('without the right to change the template', () => {
    it('shows the roles but offers nothing to change', () => {
      renderStep(template({ signingOrderEnabled: true }), false);
      expect(nameInput('Client')).toBeDisabled();
      expect(screen.getByDisplayValue('ann@example.com')).toBeDisabled();
      expect(screen.getByRole('switch')).toBeDisabled();
      expect(screen.queryByRole('button', { name: tr.add })).toBeNull();
      expect(screen.queryByRole('button', { name: `${tr.remove}: Client` })).toBeNull();
      expect(screen.queryByRole('button', { name: en.weldsign.editor.documents.moveUp })).toBeNull();
      for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    });
  });
});
