import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignEnvelopeDetail, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { templates: { update: vi.fn() } } }));
const state = vi.hoisted(() => ({ permissions: new Set<string>(['sign_envelopes:create']) }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('../use-template-dialog', () => ({
  UseTemplateDialog: (props: { templateId: string | null }) =>
    props.templateId ? <div role="dialog" aria-label="use template dialog">{props.templateId}</div> : null,
}));

import { TemplateSettingsStep } from './settings-step';

const ts = en.weldsign.templates.settings;
const tr = en.weldsign.editor.review;

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
    ...overrides,
  } as SignRecipientDto;
}

const client = role({ id: 'sgr_client', roleName: 'Client' });
const director = role({ id: 'sgr_director', roleName: 'Director', routingOrder: 2 });
const signature = (recipientId: string) => ({ id: `f_${recipientId}`, recipientId, type: 'signature' }) as SignFieldDto;

/** A template that can be used and sent as it is. */
function complete(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgt_1',
    kind: 'template',
    title: 'Service agreement',
    status: 'draft',
    message: null,
    signingOrderEnabled: false,
    reminderAfterDays: null,
    reminderEveryDays: null,
    reminderMaxCount: null,
    documents: [{ id: 'sgd_1', name: 'Agreement.pdf' }],
    recipientList: [client, director],
    fields: [signature('sgr_client'), signature('sgr_director')],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(detail: SignEnvelopeDetail, editable = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <TemplateSettingsStep template={detail} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.permissions = new Set(['sign_envelopes:create']);
  api.weldsign.templates.update.mockReset();
  api.weldsign.templates.update.mockResolvedValue({ data: complete() });
});

afterEach(() => cleanup());

describe('template settings step', () => {
  it('saves the message when the box loses focus, and a cleared one as null', async () => {
    const user = userEvent.setup();
    renderStep(complete({ message: 'Please sign.' }));
    const box = screen.getByLabelText(tr.message);
    expect(box).toHaveValue('Please sign.');

    await user.clear(box);
    await user.type(box, 'Hello');
    await user.tab();
    await waitFor(() => expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { message: 'Hello' }));

    await user.clear(box);
    await user.tab();
    await waitFor(() => expect(api.weldsign.templates.update).toHaveBeenLastCalledWith('sgt_1', { message: null }));
  });

  it('does not save an unchanged message', async () => {
    const user = userEvent.setup();
    renderStep(complete({ message: 'Please sign.' }));
    await user.click(screen.getByLabelText(tr.message));
    await user.tab();
    expect(api.weldsign.templates.update).not.toHaveBeenCalled();
  });

  it('switches the signing order on', async () => {
    const user = userEvent.setup();
    renderStep(complete());
    await user.click(screen.getByRole('switch', { name: new RegExp(en.weldsign.editor.recipients.signingOrder) }));
    await waitFor(() => expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { signingOrderEnabled: true }));
  });

  it('switches reminders on with sensible defaults, and off again', async () => {
    const user = userEvent.setup();
    renderStep(complete());
    await user.click(screen.getByRole('switch', { name: new RegExp(tr.reminders) }));
    await waitFor(() =>
      expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }),
    );
  });

  it('turns reminders off', async () => {
    const user = userEvent.setup();
    renderStep(complete({ reminderAfterDays: 2, reminderEveryDays: 4, reminderMaxCount: 5 }));
    expect(screen.getByLabelText(tr.reminderAfter)).toHaveValue(2);
    await user.click(screen.getByRole('switch', { name: new RegExp(tr.reminders) }));
    await waitFor(() =>
      expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { reminderAfterDays: null, reminderEveryDays: null, reminderMaxCount: null }),
    );
  });

  it('counts documents, roles and fields', () => {
    renderStep(complete());
    const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(stat(tr.summaryDocuments)).toBe('1');
    expect(stat(ts.summaryRoles)).toBe('2');
    expect(stat(tr.summaryFields)).toBe('2');
  });

  describe('what is still missing', () => {
    it('is nothing for a complete template', () => {
      renderStep(complete());
      expect(screen.getByText(ts.ready)).toBeInTheDocument();
    });

    it('asks for a document and a role that signs on an empty template', () => {
      renderStep(complete({ documents: [], recipientList: [], fields: [] }));
      expect(screen.getByText(ts.noDocuments)).toBeInTheDocument();
      expect(screen.getByText(ts.noSigners)).toBeInTheDocument();
      expect(screen.queryByText(ts.ready)).toBeNull();
    });

    it('names the role, not a person, when a signing role has no signature field', () => {
      renderStep(complete({ fields: [signature('sgr_client')], recipientList: [client, role({ ...director, name: 'Dora', email: 'dora@example.com' })] }));
      expect(screen.getByText('The role "Director" has no signature field.')).toBeInTheDocument();
      expect(screen.queryByText(/Dora/)).toBeNull();
    });

    it('does not ask a copy role for a signature', () => {
      renderStep(complete({ recipientList: [client, role({ id: 'sgr_cc', role: 'cc', roleName: 'Accountant', routingOrder: 3 })], fields: [signature('sgr_client')] }));
      expect(screen.getByText(ts.ready)).toBeInTheDocument();
    });
  });

  describe('Use template', () => {
    it('opens the Use template dialog', async () => {
      const user = userEvent.setup();
      renderStep(complete());
      expect(screen.queryByRole('dialog')).toBeNull();
      await user.click(screen.getByRole('button', { name: ts.useTemplate }));
      expect(screen.getByRole('dialog', { name: 'use template dialog' }).textContent).toBe('sgt_1');
    });

    it.each([
      ['has no document', { documents: [] }],
      ['has no role', { recipientList: [], fields: [] }],
    ])('is disabled, with the reason, while the template %s', (_label, overrides) => {
      renderStep(complete(overrides));
      expect(screen.getByRole('button', { name: ts.useTemplate })).toBeDisabled();
      expect(screen.getByText(en.weldsign.templates.cannotUse)).toBeInTheDocument();
    });

    it('is available for a template that still misses a signature field', () => {
      renderStep(complete({ fields: [signature('sgr_client')] }));
      expect(screen.getByRole('button', { name: ts.useTemplate })).toBeEnabled();
    });

    it('is hidden without the right to make requests', () => {
      state.permissions = new Set();
      renderStep(complete());
      expect(screen.queryByRole('button', { name: ts.useTemplate })).toBeNull();
    });
  });

  describe('without the right to change the template', () => {
    it('shows everything but changes nothing, and still lets the member use it', async () => {
      const user = userEvent.setup();
      renderStep(complete({ message: 'Please sign.', reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }), false);
      expect(screen.getByLabelText(tr.message)).toBeDisabled();
      for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
      expect(screen.getByLabelText(tr.reminderAfter)).toBeDisabled();

      await user.click(screen.getByRole('button', { name: ts.useTemplate }));
      expect(screen.getByRole('dialog', { name: 'use template dialog' })).toBeInTheDocument();
    });
  });

  it('offers no Send: a template only becomes a request when it is used', () => {
    renderStep(complete());
    expect(screen.queryByRole('button', { name: tr.send })).toBeNull();
  });
});
