import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import { SIGN_LIMITS, type SignDocumentDto, type SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';

const sharedCalls = () => ({ uploadDocument: vi.fn(), addDocumentFromDrive: vi.fn(), reorderDocuments: vi.fn(), removeDocument: vi.fn() });
const api = vi.hoisted(() => ({ weldsign: {} as Record<string, unknown> }));
const calls = vi.hoisted(() => ({ envelope: {} as ReturnType<typeof sharedCalls>, template: {} as ReturnType<typeof sharedCalls> }));
const state = vi.hoisted(() => ({ permissions: new Set<string>(), files: [] as unknown[] }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('@/hooks/queries/use-drive-queries', () => ({
  useDriveFiles: () => ({ data: { success: true, data: state.files, pagination: { hasMore: false } }, isLoading: false, isError: false }),
}));
vi.mock('sonner', () => ({ toast }));

import { DocumentsStep } from './documents-step';

const td = en.weldsign.editor.documents;

function driveFile(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 1024 * 1024,
    source: 'drive',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function pdfDocument(index: number): SignDocumentDto {
  return { id: `sgd_${index}`, name: `Doc ${index}.pdf`, position: index, sizeBytes: 1024, pageCount: 1, pageSizes: [], sha256: 'x', createdAt: '2026-10-20T10:00:00.000Z' };
}

function draft(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return { id: 'sgn_1', kind: 'envelope', title: 'Agreement', status: 'draft', documents: [], recipientList: [], fields: [], canEdit: true, ...overrides } as unknown as SignEnvelopeDetail;
}

function renderStep(envelope: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <DocumentsStep envelope={envelope} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const fromDriveButton = () => screen.queryByRole('button', { name: td.fromDrive });

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  calls.envelope = sharedCalls();
  calls.template = sharedCalls();
  api.weldsign = { ...calls.envelope, templates: { ...calls.template } };
  state.permissions = new Set(['files:read']);
  state.files = [driveFile('fil_1', 'Service agreement.pdf'), driveFile('fil_2', 'NDA.pdf'), driveFile('fil_3', 'Notes.docx', { fileType: 'document', mimeType: 'text/plain' })];
  for (const fn of Object.values(toast)) fn.mockReset();
  calls.envelope.addDocumentFromDrive.mockResolvedValue({ data: pdfDocument(1) });
  calls.template.addDocumentFromDrive.mockResolvedValue({ data: pdfDocument(1) });
  calls.envelope.uploadDocument.mockResolvedValue({ data: pdfDocument(1) });
});

afterEach(() => cleanup());

describe('documents step: add from WeldDrive', () => {
  it('offers it next to the upload, with files:read', () => {
    renderStep(draft());
    expect(fromDriveButton()).toBeInTheDocument();
    expect(screen.getByText(td.drop)).toBeInTheDocument();
  });

  it('leaves it out without files:read', () => {
    state.permissions = new Set();
    renderStep(draft());
    expect(fromDriveButton()).toBeNull();
    // Uploading from the computer is not affected.
    expect(screen.getByText(td.drop)).toBeInTheDocument();
  });

  it('leaves it out for a request that can not be changed, and when the request is full', () => {
    renderStep(draft(), false);
    expect(fromDriveButton()).toBeNull();
    cleanup();

    renderStep(draft({ documents: Array.from({ length: SIGN_LIMITS.maxDocuments }, (_, i) => pdfDocument(i)) }));
    expect(fromDriveButton()).toBeNull();
  });

  it('lists the PDFs of WeldDrive and copies the chosen ones in, one after another', async () => {
    const user = userEvent.setup();
    renderStep(draft());

    await user.click(fromDriveButton()!);
    expect(screen.getByText(td.drive.title, { selector: '[data-slot="dialog-title"]' })).toBeInTheDocument();
    // Only PDFs are offered, however the list came back.
    expect(screen.queryByRole('checkbox', { name: 'Notes.docx' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Service agreement.pdf' }));
    await user.click(screen.getByRole('checkbox', { name: 'NDA.pdf' }));
    await user.click(screen.getByRole('button', { name: td.drive.confirm }));

    await waitFor(() => expect(calls.envelope.addDocumentFromDrive).toHaveBeenCalledTimes(2));
    expect(calls.envelope.addDocumentFromDrive).toHaveBeenNthCalledWith(1, 'sgn_1', { fileId: 'fil_1' });
    expect(calls.envelope.addDocumentFromDrive).toHaveBeenNthCalledWith(2, 'sgn_1', { fileId: 'fil_2' });
    expect(calls.template.addDocumentFromDrive).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says why a PDF was refused, and still adds the others', async () => {
    calls.envelope.addDocumentFromDrive.mockRejectedValueOnce(new ApiError('This PDF is password protected', 400));
    const user = userEvent.setup();
    renderStep(draft());

    await user.click(fromDriveButton()!);
    await user.click(screen.getByRole('checkbox', { name: 'Service agreement.pdf' }));
    await user.click(screen.getByRole('checkbox', { name: 'NDA.pdf' }));
    await user.click(screen.getByRole('button', { name: td.drive.confirm }));

    await waitFor(() => expect(calls.envelope.addDocumentFromDrive).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledWith('Could not add Service agreement.pdf: This PDF is password protected');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('offers no more PDFs than the request has room for', async () => {
    const user = userEvent.setup();
    renderStep(draft({ documents: Array.from({ length: SIGN_LIMITS.maxDocuments - 1 }, (_, i) => pdfDocument(i)) }));

    await user.click(fromDriveButton()!);
    await user.click(screen.getByRole('checkbox', { name: 'Service agreement.pdf' }));

    expect(screen.getByRole('checkbox', { name: 'NDA.pdf' })).toBeDisabled();
  });

  it('copies into a template through the template API', async () => {
    const user = userEvent.setup();
    renderStep(draft({ id: 'sgt_1', kind: 'template' }));

    await user.click(fromDriveButton()!);
    await user.click(screen.getByRole('checkbox', { name: 'NDA.pdf' }));
    await user.click(screen.getByRole('button', { name: td.drive.confirm }));

    await waitFor(() => expect(calls.template.addDocumentFromDrive).toHaveBeenCalledWith('sgt_1', { fileId: 'fil_2' }));
    expect(calls.envelope.addDocumentFromDrive).not.toHaveBeenCalled();
  });

  it('does not touch the draft when the picker is cancelled', async () => {
    const user = userEvent.setup();
    renderStep(draft());

    await user.click(fromDriveButton()!);
    await user.click(screen.getByRole('button', { name: en.common.actions.cancel }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.envelope.addDocumentFromDrive).not.toHaveBeenCalled();
  });
});

describe('documents step: the rest still works', () => {
  it('uploads a PDF from the computer', async () => {
    const user = userEvent.setup();
    renderStep(draft());
    const file = new File(['%PDF-1.7'], 'contract.pdf', { type: 'application/pdf' });

    await user.upload(fileInput(), file);

    await waitFor(() => expect(calls.envelope.uploadDocument).toHaveBeenCalledWith('sgn_1', file));
  });

  it('lists the documents of the request, in order', () => {
    renderStep(draft({ documents: [pdfDocument(1), pdfDocument(2)] }));
    expect(screen.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)).toEqual(['Doc 1.pdf', 'Doc 2.pdf']);
  });
});

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}
