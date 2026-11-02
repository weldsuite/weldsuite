import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignEnvelopeDetail, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({
  weldsign: {
    documentContent: vi.fn(),
    replaceFields: vi.fn(),
    templates: { documentContent: vi.fn(), replaceFields: vi.fn() },
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('sonner', () => ({ toast }));
// pdf.js has no place in jsdom: the page is a plain box that carries the field layer.
vi.mock('../lib/pdf', () => ({ openPdf: () => new Promise(() => undefined) }));
vi.mock('./pdf-page', () => ({ PdfPage: (props: { children?: ReactNode }) => <div data-testid="page">{props.children}</div> }));

import { FieldsStep } from './fields-step';

const tf = en.weldsign.editor.fields;

function recipient(overrides: Partial<SignRecipientDto>): SignRecipientDto {
  return {
    id: 'rcp_1',
    role: 'signer',
    roleName: null,
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

const doc = { id: 'sgd_1', name: 'Agreement.pdf', position: 1, sizeBytes: 1000, pageCount: 1, pageSizes: [{ width: 595, height: 842 }] };

function detail(overrides: Partial<SignEnvelopeDetail>): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Agreement',
    status: 'draft',
    documents: [doc],
    recipientList: [],
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

/** Roles of a template: the people they stand for may or may not be known. */
const client = recipient({ id: 'sgr_client', roleName: 'Client' });
const director = recipient({ id: 'sgr_director', roleName: 'Director', name: 'Dora Director', email: 'dora@example.com', routingOrder: 2 });
const accountant = recipient({ id: 'sgr_accountant', role: 'cc', roleName: 'Accountant', routingOrder: 3 });
const template = (overrides: Partial<SignEnvelopeDetail> = {}) =>
  detail({ id: 'sgt_1', kind: 'template', recipientList: [client, director, accountant], ...overrides });

/** People of a request: named, and (when it came from a template) still carrying their role. */
const ann = recipient({ id: 'rcp_ann', name: 'Ann Signer', email: 'ann@example.com', roleName: 'Client' });
const bob = recipient({ id: 'rcp_bob', email: 'bob@example.com', routingOrder: 2 });

function renderStep(step: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <FieldsStep envelope={step} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const pdfBytes = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };

beforeAll(() => {
  // Radix selects lean on pointer APIs jsdom lacks.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.weldsign.documentContent.mockReset().mockResolvedValue(pdfBytes);
  api.weldsign.replaceFields.mockReset();
  api.weldsign.templates.documentContent.mockReset().mockResolvedValue(pdfBytes);
  api.weldsign.templates.replaceFields.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(() => cleanup());

describe('fields step on a template', () => {
  it('picks the role that fills a field, by role name', () => {
    renderStep(template());
    expect(screen.getByRole('heading', { name: tf.role })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Client' })).toBeInTheDocument();
    // The usual person is only a default: the role is what a field belongs to.
    expect(screen.getByRole('button', { name: 'Director' })).toBeInTheDocument();
    expect(screen.queryByText('Dora Director')).toBeNull();
    // A copy recipient fills in nothing.
    expect(screen.queryByRole('button', { name: 'Accountant' })).toBeNull();
  });

  it('reads the document through the template API', async () => {
    renderStep(template());
    await waitFor(() => expect(api.weldsign.templates.documentContent).toHaveBeenCalledWith('sgt_1', 'sgd_1'));
    expect(api.weldsign.documentContent).not.toHaveBeenCalled();
  });

  it('asks for a role that signs when there is none', () => {
    renderStep(template({ recipientList: [accountant] }));
    expect(screen.getByText(tf.needRoles)).toBeInTheDocument();
  });

  it('asks for a document first', () => {
    renderStep(template({ documents: [] }));
    expect(screen.getByText(tf.needDocuments)).toBeInTheDocument();
  });

  it('places a field for a role and saves the field set through the template API', async () => {
    api.weldsign.templates.replaceFields.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    renderStep(template());

    await user.click(screen.getByRole('button', { name: 'Director' }));
    await user.click(screen.getByRole('button', { name: tf.types.signature }));
    const layer = screen.getByTestId('page').firstElementChild!;
    fireEvent(layer, new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 160 }));
    await user.click(screen.getByRole('button', { name: tf.save }));

    await waitFor(() => expect(api.weldsign.templates.replaceFields).toHaveBeenCalledTimes(1));
    const [id, body] = api.weldsign.templates.replaceFields.mock.calls[0]!;
    expect(id).toBe('sgt_1');
    expect(body.fields).toEqual([expect.objectContaining({ documentId: 'sgd_1', recipientId: 'sgr_director', type: 'signature', page: 0 })]);
    expect(api.weldsign.replaceFields).not.toHaveBeenCalled();
  });

  it('shows the role a placed field is assigned to', async () => {
    const field = { id: 'sgf_1', documentId: 'sgd_1', recipientId: 'sgr_director', type: 'signature', page: 0, x: 10, y: 10, width: 160, height: 48, required: true, label: null } as SignFieldDto;
    const user = userEvent.setup();
    renderStep(template({ fields: [field] }));
    // The field on the page, not the palette entry of the same name.
    await user.click(within(screen.getByTestId('page')).getByRole('button', { name: tf.types.signature }));
    expect(screen.getByRole('combobox', { name: tf.assignedTo })).toHaveTextContent('Director');
  });
});

describe('fields step on a request', () => {
  it('picks the signer by name, as before, even when the request came from a template', () => {
    renderStep(detail({ recipientList: [ann, bob] }));
    expect(screen.getByRole('heading', { name: tf.signer })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ann Signer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bob@example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Client' })).toBeNull();
  });

  it('reads the document through the request API', async () => {
    renderStep(detail({ recipientList: [ann] }));
    await waitFor(() => expect(api.weldsign.documentContent).toHaveBeenCalledWith('sgn_1', 'sgd_1'));
    expect(api.weldsign.templates.documentContent).not.toHaveBeenCalled();
  });

  it('asks for a signer when there is none', () => {
    renderStep(detail({ recipientList: [] }));
    expect(screen.getByText(tf.needSigners)).toBeInTheDocument();
  });

  it('saves the field set through the request API', async () => {
    api.weldsign.replaceFields.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    renderStep(detail({ recipientList: [ann] }));

    await user.click(screen.getByRole('button', { name: tf.types.signature }));
    const layer = screen.getByTestId('page').firstElementChild!;
    fireEvent(layer, new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 160 }));
    await user.click(screen.getByRole('button', { name: tf.save }));

    await waitFor(() => expect(api.weldsign.replaceFields).toHaveBeenCalledTimes(1));
    expect(api.weldsign.replaceFields.mock.calls[0]![0]).toBe('sgn_1');
    expect(api.weldsign.templates.replaceFields).not.toHaveBeenCalled();
  });

  describe('when the request changes elsewhere', () => {
    const view = (step: SignEnvelopeDetail, client: QueryClient) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">
          <FieldsStep envelope={step} editable />
        </I18nProvider>
      </QueryClientProvider>
    );
    const onPage = () => within(screen.getByTestId('page')).queryAllByRole('button', { name: tf.types.signature });

    it('drops an unsaved field whose signer was removed', async () => {
      const client = new QueryClient();
      const user = userEvent.setup();
      const { rerender } = render(view(detail({ recipientList: [ann, bob] }), client));

      await user.click(screen.getByRole('button', { name: 'bob@example.com' }));
      await user.click(screen.getByRole('button', { name: tf.types.signature }));
      fireEvent(screen.getByTestId('page').firstElementChild!, new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 160 }));
      expect(onPage()).toHaveLength(1);

      rerender(view(detail({ recipientList: [ann] }), client));
      expect(onPage()).toHaveLength(0);
    });

    it('takes over the fields saved elsewhere when nothing here is unsaved', () => {
      const client = new QueryClient();
      const field = { id: 'sgf_1', documentId: 'sgd_1', recipientId: 'rcp_ann', type: 'signature', page: 0, x: 10, y: 10, width: 160, height: 48, required: true, label: null } as SignFieldDto;
      const { rerender } = render(view(detail({ recipientList: [ann] }), client));
      expect(onPage()).toHaveLength(0);

      rerender(view(detail({ recipientList: [ann], fields: [field] }), client));
      expect(onPage()).toHaveLength(1);
    });
  });
});
