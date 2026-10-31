import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignEnvelopeDetail, SignRecipientDto, SignRecipientSuggestion } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({
  weldsign: { update: vi.fn(), addRecipient: vi.fn(), updateRecipient: vi.fn(), removeRecipient: vi.fn(), recipientSuggestions: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
/** The CRM's contacts and the workspace's teammates the add search sees, and who may do what. */
const directory = vi.hoisted(() => ({
  people: [] as { id: string; fullName?: string; firstName?: string; lastName?: string; email: string | null }[],
  members: [] as { userId: string; name: string | null; email: string | null }[],
  createPerson: vi.fn(),
  /** `POST /people/resolve-by-emails`: the contacts that have an email already. */
  resolve: vi.fn(),
  permissions: new Set<string>(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api, useAppApiClient: () => ({ getClient: async () => ({ post: directory.resolve }) }) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => directory.permissions.has(permission) }));
vi.mock('@/components/objects/person/use-person-data', () => ({
  usePersonSearch: (query: string, enabled: boolean) => ({ data: enabled && query.trim() ? { data: directory.people } : undefined }),
  useCreatePerson: () => ({ mutateAsync: directory.createPerson, isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: (_page: number, _size: number, enabled: boolean) => ({ data: enabled ? { data: directory.members } : undefined }),
}));

import { RecipientsStep } from './recipients-step';

const tr = en.weldsign.editor.recipients;
/** The `{name}` placeholders of the locale files, filled in. */
const format = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

function recipient(overrides: Partial<SignRecipientDto>): SignRecipientDto {
  return {
    id: 'rcp_ann',
    role: 'signer',
    roleName: null,
    name: 'Ann',
    email: 'ann@example.com',
    personId: null,
    locale: 'en',
    routingOrder: 1,
    authMode: 'link',
    hasAccessCode: false,
    status: 'pending',
    ...overrides,
  } as SignRecipientDto;
}

function draft(recipientList: SignRecipientDto[], overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Agreement',
    status: 'draft',
    signingOrderEnabled: false,
    documents: [],
    recipientList,
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(envelope: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <RecipientsStep envelope={envelope} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.update.mockResolvedValue({ data: draft([]) });
  api.weldsign.updateRecipient.mockResolvedValue({ data: recipient({}) });
  api.weldsign.addRecipient.mockResolvedValue({ data: recipient({}) });
  api.weldsign.recipientSuggestions.mockResolvedValue({ data: [] });
  directory.people = [];
  directory.members = [];
  directory.createPerson.mockReset();
  directory.createPerson.mockResolvedValue({ data: { id: 'per_new' } });
  directory.resolve.mockReset();
  directory.resolve.mockResolvedValue({ data: [] });
  directory.permissions = new Set(['people:read', 'people:create']);
});

const bob = () => recipient({ id: 'rcp_bob', name: 'Bob', email: 'bob@example.com', routingOrder: 2 });

/** A person's row in the list, found by the click target that carries their name. */
const rowOf = (name: string) => screen.getByRole('button', { name }).parentElement!;

/** Picks `option` in the select named `label`. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}

/** Opens a person's edit form from their row's menu. */
async function edit(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: format(tr.actions, { name }) }));
  await user.click(screen.getByRole('menuitem', { name: en.common.actions.edit }));
}

/** Opens "Add recipient" and types into its search. */
async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('button', { name: tr.add }));
  if (text) await user.type(screen.getByPlaceholderText(tr.search), text);
}

afterEach(() => cleanup());

describe('recipients step', () => {
  describe('a draft made from a template', () => {
    const fromTemplate = draft([
      recipient({ id: 'rcp_ann', name: 'Ann', roleName: 'Client' }),
      recipient({ id: 'rcp_bob', name: 'Bob', email: 'bob@example.com', roleName: 'Director', routingOrder: 2 }),
      recipient({ id: 'rcp_cara', name: 'Cara', email: 'cara@example.com', roleName: null, routingOrder: 3 }),
    ]);

    it('shows the role each person fills', () => {
      renderStep(fromTemplate);
      expect(within(rowOf('Ann')).getByText('Client')).toBeInTheDocument();
      expect(within(rowOf('Ann')).getByTitle('Role in the template: Client')).toBeInTheDocument();
      expect(within(rowOf('Bob')).getByText('Director')).toBeInTheDocument();
    });

    it('shows no role for someone added by hand', () => {
      renderStep(fromTemplate);
      expect(within(rowOf('Cara')).queryByTitle(/^Role in the template/)).toBeNull();
    });

    it('lets the people be changed as in any draft', async () => {
      const user = userEvent.setup();
      renderStep(fromTemplate);
      await edit(user, 'Ann');
      const name = screen.getByDisplayValue('Ann');
      await user.clear(name);
      await user.type(name, 'Anna');
      await user.click(screen.getByRole('button', { name: en.common.actions.save }));
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { name: 'Anna' }));
    });
  });

  describe('an ordinary draft', () => {
    it('shows no role label', () => {
      renderStep(draft([recipient({})]));
      expect(screen.queryByTitle(/^Role in the template/)).toBeNull();
    });

    it('lists each person under the columns: name, email, role, language and identity check', () => {
      renderStep(draft([recipient({}), recipient({ id: 'rcp_cc', name: 'Cy', email: 'cy@example.com', role: 'cc', locale: 'nl', routingOrder: 2 })]));
      for (const header of [tr.name, tr.email, tr.role, tr.language, tr.verification]) expect(screen.getByText(header)).toBeInTheDocument();
      const ann = within(rowOf('Ann'));
      for (const cell of ['ann@example.com', tr.roles.signer, tr.languages.en, tr.authModes.link]) expect(ann.getByText(cell)).toBeInTheDocument();
      const cy = within(rowOf('Cy'));
      for (const cell of ['cy@example.com', tr.roles.cc, tr.languages.nl]) expect(cy.getByText(cell)).toBeInTheDocument();
      // Someone who only gets a copy has no identity check.
      expect(cy.queryByText(tr.authModes.link)).toBeNull();
    });

    it('opens the edit form with a click on the row, under who it is and without the column header', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({}), bob()]));
      expect(screen.getByText(tr.email)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Ann' }));
      expect(screen.getByDisplayValue('Ann')).toBeInTheDocument();
      expect(screen.getByText('Ann', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: en.common.actions.save })).toBeInTheDocument();
      // The header is gone; "Email" is now only the label of the field.
      expect(screen.getAllByText(tr.email)).toHaveLength(1);
      expect(screen.queryByText(tr.role, { selector: 'span.text-xs' })).toBeNull();
      // The others stay in the list.
      expect(screen.getByRole('button', { name: 'Bob' })).toBeInTheDocument();
    });

    it('offers a signing order only from two recipients on', () => {
      renderStep(draft([recipient({})], { signingOrderEnabled: true }));
      expect(screen.queryByRole('switch', { name: new RegExp(tr.signingOrder) })).toBeNull();
      // One person has no place in an order to show.
      expect(screen.queryByLabelText(tr.order)).toBeNull();
      cleanup();

      renderStep(draft([recipient({}), bob()]));
      expect(screen.getByRole('switch', { name: new RegExp(tr.signingOrder) })).toBeInTheDocument();
    });

    it('changes the signing order through the request API', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({}), bob()]));
      await user.click(screen.getByRole('switch', { name: new RegExp(tr.signingOrder) }));
      await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { signingOrderEnabled: true }));
    });

    it('swaps the order of two recipients', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({}), bob()], { signingOrderEnabled: true }));
      await user.click(screen.getByRole('button', { name: format(tr.actions, { name: 'Ann' }) }));
      await user.click(screen.getByRole('menuitem', { name: en.weldsign.editor.documents.moveDown }));
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledTimes(2));
      expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { routingOrder: 2 });
      expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_bob', { routingOrder: 1 });
    });

    it('edits the settings in place, saving only what changed', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await edit(user, 'Ann');
      await choose(user, tr.language, tr.languages.nl);
      await choose(user, tr.verification, tr.authModes.email_code);
      await user.click(screen.getByRole('button', { name: en.common.actions.save }));
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { locale: 'nl', authMode: 'email_code' }));
    });

    it('closes with the X too, without saving', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await edit(user, 'Ann');
      await user.clear(screen.getByDisplayValue('Ann'));
      await user.click(screen.getByRole('button', { name: en.common.actions.close }));
      expect(screen.queryByLabelText(tr.name)).toBeNull();
      expect(screen.getByRole('button', { name: 'Ann' })).toBeInTheDocument();
      expect(api.weldsign.updateRecipient).not.toHaveBeenCalled();
    });

    it('puts the row back on Cancel, without saving', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await edit(user, 'Ann');
      await user.clear(screen.getByDisplayValue('Ann'));
      await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
      expect(screen.getByRole('button', { name: format(tr.actions, { name: 'Ann' }) })).toBeInTheDocument();
      expect(screen.queryByLabelText(tr.name)).toBeNull();
      expect(api.weldsign.updateRecipient).not.toHaveBeenCalled();
    });

    it('needs the access code before an access code check is saved', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await edit(user, 'Ann');
      await choose(user, tr.verification, tr.authModes.access_code);
      await user.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(toast.error).toHaveBeenCalledWith(tr.accessCodeRequired);
      expect(api.weldsign.updateRecipient).not.toHaveBeenCalled();

      await user.type(screen.getByLabelText(tr.accessCode), '4321');
      await user.click(screen.getByRole('button', { name: en.common.actions.save }));
      await waitFor(() =>
        expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { authMode: 'access_code', accessCode: '4321' }),
      );
    });

    it('drops the identity check of someone who now only gets a copy', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({ authMode: 'email_code' })]));
      await edit(user, 'Ann');
      await choose(user, tr.role, tr.roles.cc);
      expect(screen.queryByRole('combobox', { name: tr.verification })).toBeNull();
      await user.click(screen.getByRole('button', { name: en.common.actions.save }));
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { role: 'cc', authMode: 'link' }));
    });

    it('is read-only when the draft cannot be changed', () => {
      renderStep(draft([recipient({}), bob()]), false);
      expect(screen.getByRole('switch')).toBeDisabled();
      expect(screen.queryByRole('button', { name: tr.add })).toBeNull();
      expect(screen.queryByRole('button', { name: format(tr.actions, { name: 'Ann' }) })).toBeNull();
    });
  });

  describe('adding someone', () => {
    it('first asks who, then how, then adds them as a row', async () => {
      directory.people = [{ id: 'per_lee', fullName: 'Lee Park', email: 'Lee@Acme.test' }];
      api.weldsign.addRecipient.mockResolvedValue({ data: recipient({ id: 'rcp_lee', name: 'Lee Park', email: 'lee@acme.test' }) });
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'lee');
      await user.click(screen.getByRole('option', { name: /Lee Park/ }));

      // Who was picked is shown; how they sign is asked.
      expect(screen.getByText('lee@acme.test')).toBeInTheDocument();
      expect(screen.queryByLabelText(tr.name)).toBeNull();
      await choose(user, tr.role, tr.roles.cc);
      await choose(user, tr.language, tr.languages.nl);
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));

      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', {
          name: 'Lee Park',
          email: 'lee@acme.test',
          role: 'cc',
          locale: 'nl',
          authMode: 'link',
          personId: 'per_lee',
        }),
      );
      await waitFor(() => expect(screen.getByRole('button', { name: tr.add })).toBeInTheDocument());
    });

    it('adds a teammate, as a signer by default', async () => {
      directory.members = [{ userId: 'usr_tom', name: 'Tom Team', email: 'tom@example.com' }];
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, '');
      expect(screen.getByText(tr.teammates)).toBeInTheDocument();
      await user.click(screen.getByRole('option', { name: /Tom Team/ }));
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', {
          name: 'Tom Team',
          email: 'tom@example.com',
          role: 'signer',
          locale: 'en',
          authMode: 'link',
          personId: null,
        }),
      );
    });

    it('sends the access code along when that is the check', async () => {
      directory.members = [{ userId: 'usr_tom', name: 'Tom Team', email: 'tom@example.com' }];
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, '');
      await user.click(screen.getByRole('option', { name: /Tom Team/ }));
      await choose(user, tr.verification, tr.authModes.access_code);
      await user.type(screen.getByLabelText(tr.accessCode), '9876');
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', expect.objectContaining({ authMode: 'access_code', accessCode: '9876' })),
      );
    });

    it('adds no one when the picked person is cancelled', async () => {
      directory.members = [{ userId: 'usr_tom', name: 'Tom Team', email: 'tom@example.com' }];
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, '');
      await user.click(screen.getByRole('option', { name: /Tom Team/ }));
      await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));
      expect(screen.getByRole('button', { name: tr.add })).toBeInTheDocument();
      expect(api.weldsign.addRecipient).not.toHaveBeenCalled();
    });

    it('does not offer anyone who is on the request already', async () => {
      directory.people = [{ id: 'per_ann', fullName: 'Ann', email: 'ANN@example.com' }];
      directory.members = [{ userId: 'usr_ann', name: 'Ann', email: 'ann@example.com' }];
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await search(user, 'ann');
      expect(screen.queryByRole('option', { name: /ann@example.com/ })).toBeNull();
      expect(screen.getByRole('option', { name: format(tr.newNamed, { query: 'ann' }) })).toBeInTheDocument();
    });

    it('searches teammates only without people:read', async () => {
      directory.permissions = new Set();
      directory.people = [{ id: 'per_lee', fullName: 'Lee Park', email: 'lee@acme.test' }];
      const user = userEvent.setup();
      renderStep(draft([]));
      await user.click(screen.getByRole('button', { name: tr.add }));
      await user.type(screen.getByPlaceholderText(tr.searchTeammates), 'lee');
      expect(screen.queryByRole('option', { name: /Lee Park/ })).toBeNull();
    });

    it('adds someone new, the name read from the email, and puts them in the CRM', async () => {
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'dan.smith@example.com');
      await user.click(screen.getByRole('option', { name: format(tr.newNamed, { query: 'dan.smith@example.com' }) }));
      expect(screen.getByLabelText(tr.name)).toHaveValue('Dan Smith');
      expect(screen.getByLabelText(tr.email)).toHaveValue('dan.smith@example.com');
      // Not a choice: someone new always becomes a contact.
      expect(screen.queryByRole('checkbox')).toBeNull();
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));

      await waitFor(() => expect(directory.createPerson).toHaveBeenCalledWith({ firstName: 'Dan', lastName: 'Smith', email: 'dan.smith@example.com' }));
      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', {
          name: 'Dan Smith',
          email: 'dan.smith@example.com',
          role: 'signer',
          locale: 'en',
          authMode: 'link',
          personId: 'per_new',
        }),
      );
    });

    it('links the contact that has the email already, instead of making a second one', async () => {
      directory.resolve.mockResolvedValue({ data: [{ id: 'per_dan', displayName: 'Dan Smith', email: 'Dan@Example.com' }] });
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'Dan Smith');
      await user.click(screen.getByRole('option', { name: format(tr.newNamed, { query: 'Dan Smith' }) }));
      await user.type(screen.getByLabelText(tr.email), 'dan@example.com');
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));

      await waitFor(() => expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', expect.objectContaining({ email: 'dan@example.com', personId: 'per_dan' })));
      expect(directory.resolve).toHaveBeenCalledWith('/people/resolve-by-emails', { emails: ['dan@example.com'] });
      expect(directory.createPerson).not.toHaveBeenCalled();
    });

    it('adds no one when the CRM refuses the contact', async () => {
      directory.createPerson.mockRejectedValue(new Error('Could not create the person'));
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'dan@example.com');
      await user.click(screen.getByRole('option', { name: format(tr.newNamed, { query: 'dan@example.com' }) }));
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      await waitFor(() => expect(directory.createPerson).toHaveBeenCalled());
      expect(api.weldsign.addRecipient).not.toHaveBeenCalled();
      // The form stays, so nothing typed is lost.
      expect(screen.getByLabelText(tr.email)).toHaveValue('dan@example.com');
    });

    it('adds someone new without a contact for whoever may not make contacts', async () => {
      directory.permissions = new Set(['people:read']);
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'dan@example.com');
      await user.click(screen.getByRole('option', { name: format(tr.newNamed, { query: 'dan@example.com' }) }));
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      await waitFor(() => expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', expect.objectContaining({ email: 'dan@example.com', personId: null })));
      expect(directory.createPerson).not.toHaveBeenCalled();
    });

    it('makes no contact for a teammate', async () => {
      directory.members = [{ userId: 'usr_tom', name: 'Tom Team', email: 'tom@example.com' }];
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, '');
      await user.click(screen.getByRole('option', { name: /Tom Team/ }));
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      await waitFor(() => expect(api.weldsign.addRecipient).toHaveBeenCalled());
      expect(directory.resolve).not.toHaveBeenCalled();
      expect(directory.createPerson).not.toHaveBeenCalled();
    });

    it('asks for a valid email', async () => {
      const user = userEvent.setup();
      renderStep(draft([]));
      await search(user, 'Dan');
      await user.click(screen.getByRole('option', { name: format(tr.newNamed, { query: 'Dan' }) }));
      await user.click(screen.getByRole('button', { name: en.common.actions.add }));
      expect(toast.error).toHaveBeenCalledWith(tr.invalidEmail);
      expect(api.weldsign.addRecipient).not.toHaveBeenCalled();
    });
  });

  describe('a draft that started from a CRM record', () => {
    const company = { entityType: 'company', entityId: 'cus_1', name: 'Acme BV' } as const;
    const lee: SignRecipientSuggestion = { personId: 'per_lee', name: 'Ann Lee', email: 'ann.lee@acme.test', title: 'Director' };
    const kim: SignRecipientSuggestion = { personId: 'per_kim', name: 'Kim Roe', email: 'kim.roe@acme.test', title: null };

    const chip = (name: string) => screen.queryByRole('button', { name: new RegExp(name) });

    it('offers the people on the record, one button each', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee, kim] });
      renderStep(draft([], { source: company }));

      expect(await screen.findByText('Suggested from Acme BV')).toBeInTheDocument();
      expect(chip('Ann Lee')).toHaveTextContent('ann.lee@acme.test');
      expect(chip('Kim Roe')).toBeInTheDocument();
      expect(api.weldsign.recipientSuggestions).toHaveBeenCalledWith('sgn_1');
    });

    it('adds a person as a signer in one click, with the person they are in the CRM', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee, kim] });
      const user = userEvent.setup();
      renderStep(draft([], { source: company }));

      await user.click(await screen.findByRole('button', { name: /Ann Lee/ }));

      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', {
          name: 'Ann Lee',
          email: 'ann.lee@acme.test',
          role: 'signer',
          locale: 'en',
          personId: 'per_lee',
        }),
      );
      expect(api.weldsign.addRecipient).toHaveBeenCalledTimes(1);
    });

    it('does not offer someone already on the draft, whatever the case of their email', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee, kim] });
      renderStep(draft([recipient({ id: 'rcp_lee', name: 'Ann', email: 'Ann.Lee@Acme.test' })], { source: company }));

      expect(await screen.findByRole('button', { name: /Kim Roe/ })).toBeInTheDocument();
      expect(chip('Ann Lee')).toBeNull();
    });

    it('shows nothing once everyone is on the draft', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee] });
      renderStep(draft([recipient({ email: 'ann.lee@acme.test' })], { source: company }));

      await waitFor(() => expect(api.weldsign.recipientSuggestions).toHaveBeenCalled());
      expect(screen.queryByText(/^Suggested from/)).toBeNull();
    });

    it('shows nothing when the record has no one with an email', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [] });
      renderStep(draft([], { source: company }));

      await waitFor(() => expect(api.weldsign.recipientSuggestions).toHaveBeenCalled());
      expect(screen.queryByText(/^Suggested from/)).toBeNull();
    });

    it('shows nothing, and does not complain, when the suggestions can not be read', async () => {
      api.weldsign.recipientSuggestions.mockRejectedValue(new Error('Forbidden'));
      renderStep(draft([], { source: company }));

      await waitFor(() => expect(api.weldsign.recipientSuggestions).toHaveBeenCalled());
      expect(screen.queryByText(/^Suggested from/)).toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('works for a person and an opportunity too', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [kim] });
      renderStep(draft([], { source: { entityType: 'opportunity', entityId: 'opp_1', name: 'Website rebuild' } }));
      expect(await screen.findByText('Suggested from Website rebuild')).toBeInTheDocument();
    });

    it('says why a person could not be added', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee] });
      api.weldsign.addRecipient.mockRejectedValue(new Error('A request can have at most 20 recipients'));
      const user = userEvent.setup();
      renderStep(draft([], { source: company }));

      await user.click(await screen.findByRole('button', { name: /Ann Lee/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A request can have at most 20 recipients'));
    });

    it('is not offered when the draft can not be changed', async () => {
      api.weldsign.recipientSuggestions.mockResolvedValue({ data: [lee] });
      renderStep(draft([], { source: company }), false);

      expect(screen.queryByText(/^Suggested from/)).toBeNull();
      expect(api.weldsign.recipientSuggestions).not.toHaveBeenCalled();
    });
  });

  describe('a draft without a CRM record', () => {
    it.each([
      ['no source', null],
      ['a WeldDrive file', { entityType: 'file', entityId: 'fil_1', name: 'Contract.pdf' }],
    ] as const)('asks for no suggestions with %s', (_label, source) => {
      renderStep(draft([], { source }));
      expect(api.weldsign.recipientSuggestions).not.toHaveBeenCalled();
      expect(screen.queryByText(/^Suggested from/)).toBeNull();
    });
  });
});
