import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { templates: { get: vi.fn(), update: vi.fn() } } }));
const state = vi.hoisted(() => ({ permissions: new Set<string>(['sign_templates:read']) }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ templateId: 'sgt_1' }), useNavigate: () => () => Promise.resolve() }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

// The steps have their own tests; here they only show what the editor hands them.
vi.mock('../../envelope/documents-step', () => ({
  DocumentsStep: (props: { envelope: SignEnvelopeDetail; editable: boolean }) => (
    <div data-testid="documents-step" data-editable={String(props.editable)} data-kind={props.envelope.kind} />
  ),
}));
vi.mock('../../envelope/fields-step', () => ({
  FieldsStep: (props: { envelope: SignEnvelopeDetail; editable: boolean }) => (
    <div data-testid="fields-step" data-editable={String(props.editable)} data-kind={props.envelope.kind} />
  ),
}));
vi.mock('./roles-step', () => ({
  RolesStep: (props: { template: SignEnvelopeDetail; editable: boolean }) => (
    <div data-testid="roles-step" data-editable={String(props.editable)} data-id={props.template.id} />
  ),
}));
vi.mock('./settings-step', () => ({
  TemplateSettingsStep: (props: { template: SignEnvelopeDetail; editable: boolean }) => (
    <div data-testid="settings-step" data-editable={String(props.editable)} data-id={props.template.id} />
  ),
}));

import TemplatePage from './page';

const tt = en.weldsign.templates;
const steps = en.weldsign.editor.steps;

function template(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgt_1',
    kind: 'template',
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
        <TemplatePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const stepButtons = () => screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-current') || /^\d?\s*(Documents|Roles|Fields|Settings|Recipients|Review)$/.test(button.textContent ?? ''));

beforeEach(() => {
  state.permissions = new Set(['sign_templates:read']);
  api.weldsign.templates.get.mockReset();
  api.weldsign.templates.update.mockReset();
  api.weldsign.templates.get.mockResolvedValue({ data: template() });
  api.weldsign.templates.update.mockResolvedValue({ data: template() });
});

afterEach(() => cleanup());

describe('template editor', () => {
  it('opens on Documents with the template steps: documents, roles, fields, settings', async () => {
    renderPage();
    expect(await screen.findByTestId('documents-step')).toHaveAttribute('data-kind', 'template');
    expect(screen.getByRole('button', { name: 'Service agreement' })).toBeInTheDocument();
    expect(screen.getByText(tt.editor.badge)).toBeInTheDocument();

    const labels = stepButtons().map((button) => button.textContent?.replace(/^\d+/, ''));
    expect(labels).toEqual([steps.documents, steps.roles, steps.fields, steps.settings]);
    // A template has no recipients to enter and nothing to send.
    expect(screen.queryByRole('button', { name: steps.recipients })).toBeNull();
    expect(screen.queryByRole('button', { name: steps.review })).toBeNull();
    expect(screen.queryByRole('button', { name: en.weldsign.editor.review.send })).toBeNull();
  });

  it('moves through the steps with the step buttons and Next / Back', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('documents-step');
    expect(screen.getByRole('button', { name: en.weldsign.editor.back })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: en.weldsign.editor.next }));
    expect(screen.getByTestId('roles-step')).toHaveAttribute('data-id', 'sgt_1');

    await user.click(screen.getByRole('button', { name: new RegExp(steps.settings) }));
    expect(screen.getByTestId('settings-step')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.weldsign.editor.next })).toBeNull();

    await user.click(screen.getByRole('button', { name: en.weldsign.editor.back }));
    expect(screen.getByTestId('fields-step')).toHaveAttribute('data-kind', 'template');
  });

  it('saves the title through the template API', async () => {
    const user = userEvent.setup();
    renderPage();
    // The title is edited as a task title is: click it, then type.
    await user.click(await screen.findByRole('button', { name: 'Service agreement' }));
    const input = screen.getByLabelText(tt.editor.titleLabel);
    await user.clear(input);
    await user.type(input, 'NDA');
    await user.tab();
    await waitFor(() => expect(api.weldsign.templates.update).toHaveBeenCalledWith('sgt_1', { title: 'NDA' }));
  });

  it('puts the old title back when it is emptied', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Service agreement' }));
    await user.clear(screen.getByLabelText(tt.editor.titleLabel));
    await user.tab();
    expect(api.weldsign.templates.update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Service agreement' })).toBeInTheDocument();
  });

  it('is read-only, and says so, without sign_templates:update', async () => {
    api.weldsign.templates.get.mockResolvedValue({ data: template({ canEdit: false }) });
    renderPage();
    expect(await screen.findByText(tt.editor.readOnly)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Service agreement' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Service agreement' })).toBeNull();
    expect(screen.getByTestId('documents-step')).toHaveAttribute('data-editable', 'false');
  });

  it('is editable when the template says the caller may change it', async () => {
    renderPage();
    expect(await screen.findByTestId('documents-step')).toHaveAttribute('data-editable', 'true');
    expect(screen.queryByText(tt.editor.readOnly)).toBeNull();
  });

  it('says when the template does not exist', async () => {
    api.weldsign.templates.get.mockRejectedValue(new ApiError('Not found', 404));
    renderPage();
    expect(await screen.findByText(tt.editor.notFound)).toBeInTheDocument();
  });

  it('says when the template could not be loaded', async () => {
    api.weldsign.templates.get.mockRejectedValue(new ApiError('Server error', 500));
    renderPage();
    expect(await screen.findByText(tt.editor.loadFailed)).toBeInTheDocument();
  });

  it('does not even ask for the template without sign_templates:read', () => {
    state.permissions = new Set();
    renderPage();
    expect(screen.getByText(tt.noAccess)).toBeInTheDocument();
    expect(api.weldsign.templates.get).not.toHaveBeenCalled();
  });
});
