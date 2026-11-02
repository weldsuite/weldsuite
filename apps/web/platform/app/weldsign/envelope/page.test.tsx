import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { get: vi.fn(), update: vi.fn() } }));
/** What the field editor reports; each test sets what it needs. */
const fieldEditor = vi.hoisted(() => ({ dirty: false, saving: false, armed: null, fields: [] as unknown[], save: (() => Promise.resolve()) as () => Promise<void> }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ envelopeId: 'sgn_1' }), useNavigate: () => () => Promise.resolve() }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

// The parts have their own tests; here they only show where they are put.
vi.mock('./documents-step', () => ({
  useDocuments: () => ({ dropHandlers: {}, dragOver: false }),
  DocumentDialogs: () => null,
  DocumentList: () => <div data-testid="document-list" />,
  DocumentsEmptyState: () => <div data-testid="documents-empty" />,
  DropOverlay: () => null,
}));
vi.mock('./fields-step', () => ({
  useFieldEditor: () => fieldEditor,
  documentAnchor: (id: string) => id,
  FieldPages: () => <div data-testid="field-pages" />,
  FieldTools: () => <div data-testid="field-tools" />,
}));
vi.mock('./recipients-step', () => ({ RecipientsStep: () => <div data-testid="recipients" /> }));
vi.mock('./review-step', () => ({
  ReviewSettings: () => <div data-testid="settings" />,
  ReviewSummary: () => <div data-testid="summary" />,
  SendButton: () => <button type="button">{en.weldsign.editor.review.send}</button>,
}));
vi.mock('./overview', () => ({ EnvelopeOverview: () => <div data-testid="overview" /> }));

import EnvelopePage from './page';

const te = en.weldsign.editor;

function envelope(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Service agreement',
    status: 'draft',
    documents: [],
    recipientList: [],
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <EnvelopePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.weldsign.get.mockReset();
  api.weldsign.update.mockReset();
  api.weldsign.get.mockResolvedValue({ data: envelope() });
  api.weldsign.update.mockResolvedValue({ data: envelope() });
  Object.assign(fieldEditor, { dirty: false, saving: false, armed: null, fields: [], save: () => Promise.resolve() });
});

afterEach(() => cleanup());

describe('request editor', () => {
  it('shows a draft on one page: the documents on the left, the request on the right', async () => {
    renderPage();
    const preview = await screen.findByRole('region', { name: te.preview });
    expect(preview).toContainElement(screen.getByTestId('documents-empty'));
    for (const title of [te.documents.title, te.recipients.title, te.fields.title, te.steps.settings]) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByTestId('summary')).toBeInTheDocument();
    // No steps any more.
    expect(screen.queryByRole('navigation', { name: te.stepsLabel })).toBeNull();
    expect(screen.queryByRole('button', { name: te.next })).toBeNull();
  });

  it('shows the pages, with their fields, once there is a document', async () => {
    api.weldsign.get.mockResolvedValue({ data: envelope({ documents: [{ id: 'sgd_1', name: 'Agreement.pdf' }] as SignEnvelopeDetail['documents'] }) });
    renderPage();
    expect(await screen.findByTestId('field-pages')).toBeInTheDocument();
    expect(screen.queryByTestId('documents-empty')).toBeNull();
  });

  it('saves the title through the request API', async () => {
    const user = userEvent.setup();
    renderPage();
    // The title is edited as a task title is: click it, then type.
    await user.click(await screen.findByRole('button', { name: 'Service agreement' }));
    const input = screen.getByLabelText(te.titleLabel);
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { title: 'Renamed' }));
  });

  it('saves the placed fields with Save, which is off while there is nothing to save', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    renderPage();
    expect(await screen.findByRole('button', { name: te.save })).toBeDisabled();
    cleanup();

    Object.assign(fieldEditor, { dirty: true, save });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: te.save }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: te.review.send })).toBeInTheDocument();
  });

  it('opens a sent request on its status', async () => {
    api.weldsign.get.mockResolvedValue({ data: envelope({ status: 'sent', canEdit: false }) });
    renderPage();
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: te.preview })).toBeNull();
  });

  it('says so when the request is read-only, and leaves out Save and Send', async () => {
    api.weldsign.get.mockResolvedValue({ data: envelope({ canEdit: false }) });
    renderPage();
    expect(await screen.findByText(te.readOnly)).toBeInTheDocument();
    // The title is shown, not offered for editing.
    expect(screen.getByRole('heading', { name: 'Service agreement' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Service agreement' })).toBeNull();
    expect(screen.queryByRole('button', { name: te.save })).toBeNull();
    expect(screen.queryByRole('button', { name: te.review.send })).toBeNull();
  });

  it('says when the request does not exist', async () => {
    api.weldsign.get.mockRejectedValue(new ApiError('Not found', 404));
    renderPage();
    expect(await screen.findByText(te.notFound)).toBeInTheDocument();
  });
});
