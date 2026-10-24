import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { get: vi.fn(), update: vi.fn() } }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ envelopeId: 'sgn_1' }) }));
vi.mock('@/lib/router', () => ({ useSearchParams: () => search.params }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

// The steps have their own tests; here they only show that they were reached.
vi.mock('./documents-step', () => ({ DocumentsStep: () => <div data-testid="documents-step" /> }));
vi.mock('./recipients-step', () => ({ RecipientsStep: () => <div data-testid="recipients-step" /> }));
vi.mock('./fields-step', () => ({ FieldsStep: () => <div data-testid="fields-step" /> }));
vi.mock('./review-step', () => ({ ReviewStep: () => <div data-testid="review-step" /> }));
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
  search.params = new URLSearchParams();
  api.weldsign.get.mockReset();
  api.weldsign.update.mockReset();
  api.weldsign.get.mockResolvedValue({ data: envelope() });
  api.weldsign.update.mockResolvedValue({ data: envelope() });
});

afterEach(() => cleanup());

describe('request editor', () => {
  it('opens a draft on Documents', async () => {
    renderPage();
    expect(await screen.findByTestId('documents-step')).toBeInTheDocument();
    expect(screen.queryByTestId('review-step')).toBeNull();
  });

  it('opens on Review with ?step=review: where a draft made from a template lands', async () => {
    search.params = new URLSearchParams('step=review');
    renderPage();
    expect(await screen.findByTestId('review-step')).toBeInTheDocument();
    expect(screen.queryByTestId('documents-step')).toBeNull();
    // The earlier steps are still one click away.
    expect(screen.getByRole('button', { name: new RegExp(te.steps.documents) })).toBeInTheDocument();
  });

  it('opens on Recipients with ?step=recipients: where a draft made from a WeldDrive file lands', async () => {
    search.params = new URLSearchParams('step=recipients');
    renderPage();
    expect(await screen.findByTestId('recipients-step')).toBeInTheDocument();
    expect(screen.queryByTestId('documents-step')).toBeNull();
    // The document step is one click away, and Back leads to it.
    expect(screen.getByRole('button', { name: new RegExp(te.steps.documents) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: te.back })).toBeEnabled();
  });

  it('carries on from Recipients to Fields as from any other start', async () => {
    const user = userEvent.setup();
    search.params = new URLSearchParams('step=recipients');
    renderPage();
    await screen.findByTestId('recipients-step');
    await user.click(screen.getByRole('button', { name: te.next }));
    expect(screen.getByTestId('fields-step')).toBeInTheDocument();
  });

  it('ignores any other step in the address', async () => {
    for (const step of ['fields', 'documents', 'nonsense', '']) {
      search.params = new URLSearchParams({ step });
      cleanup();
      renderPage();
      expect(await screen.findByTestId('documents-step'), step).toBeInTheDocument();
    }
  });

  it('still has the four request steps: documents, recipients, fields, review', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('documents-step');

    await user.click(screen.getByRole('button', { name: new RegExp(te.steps.recipients) }));
    expect(screen.getByTestId('recipients-step')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: te.next }));
    expect(screen.getByTestId('fields-step')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: te.next }));
    expect(screen.getByTestId('review-step')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: te.next })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(`${en.weldsign.templates.roles.title}$`) })).toBeNull();
  });

  it('saves the title through the request API', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText(te.titleLabel);
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { title: 'Renamed' }));
  });

  it('opens a sent request on its status, not on the steps', async () => {
    api.weldsign.get.mockResolvedValue({ data: envelope({ status: 'sent', canEdit: false }) });
    search.params = new URLSearchParams('step=review');
    renderPage();
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByTestId('review-step')).toBeNull();
  });

  it('says so when the request is read-only', async () => {
    api.weldsign.get.mockResolvedValue({ data: envelope({ canEdit: false }) });
    renderPage();
    expect(await screen.findByText(te.readOnly)).toBeInTheDocument();
    expect(screen.getByLabelText(te.titleLabel)).toBeDisabled();
  });

  it('says when the request does not exist', async () => {
    api.weldsign.get.mockRejectedValue(new ApiError('Not found', 404));
    renderPage();
    expect(await screen.findByText(te.notFound)).toBeInTheDocument();
  });
});
