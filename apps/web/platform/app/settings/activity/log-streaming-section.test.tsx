import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import {
  MAX_AUDIT_LOG_STREAMS,
  type AuditLogStream,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';

const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => permissions.granted.has(permission),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));

const api = vi.hoisted(() => ({ auditLogStreams: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ auditLogStreams: api.auditLogStreams }) }));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { LogStreamingSection } from './log-streaming-section';

const ts = en.settings.logStreaming;

function makeStream(overrides: Partial<AuditLogStream> = {}): AuditLogStream {
  return {
    id: 'als_1',
    name: 'Production Splunk',
    type: 'splunk_hec',
    url: 'https://splunk.example.com:8088/services/collector/event',
    hasToken: true,
    settings: null,
    status: 'active',
    cursorCreatedAt: null,
    lastDeliveredAt: null,
    lastAttemptAt: null,
    lastError: null,
    consecutiveFailures: 0,
    deliveredCount: 0,
    createdById: 'user_1',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

const answer = <T,>(data: T) => ({ data: JSON.parse(JSON.stringify(data)) as T, pagination: { totalCount: 0, hasMore: false, cursor: null } });
const refusal = (status: number, message: string, details?: Record<string, unknown>) =>
  new ApiError(message, status, { error: { code: 'ERR', message, details } });

let streams: AuditLogStream[];

function render(granted: string[] = ['general:update']) {
  permissions.granted = new Set(granted);
  return renderWithProviders(<LogStreamingSection />);
}

/** Opens the row menu of a stream and clicks one of its items. */
async function rowAction(user: ReturnType<typeof userEvent.setup>, streamName: string, item: string) {
  await user.click(screen.getByRole('button', { name: `${ts.actions.menu}: ${streamName}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  streams = [];
  api.auditLogStreams.list = vi.fn(async () => answer(streams));
  api.auditLogStreams.create = vi.fn(async (input: Record<string, unknown>) => ({ data: makeStream({ id: 'als_new', name: String(input.name) }) }));
  api.auditLogStreams.update = vi.fn(async (id: string) => ({ data: makeStream({ id }) }));
  api.auditLogStreams.delete = vi.fn(async () => undefined);
  api.auditLogStreams.test = vi.fn(async () => ({ data: { ok: true, status: 200, error: null, durationMs: 42 } }));
});

describe('LogStreamingSection access', () => {
  it('renders nothing, and loads nothing, without general:update', () => {
    const { container } = render(['team:read']);
    expect(container).toBeEmptyDOMElement();
    expect(api.auditLogStreams.list).not.toHaveBeenCalled();
  });
});

describe('LogStreamingSection list', () => {
  it('explains delivery and offers a first stream when there is none', async () => {
    render();
    expect(await screen.findByText(ts.empty.title)).toBeInTheDocument();
    expect(screen.getByText(ts.delivery.start)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: ts.add })[0]).toBeEnabled();
  });

  it('shows each status with the host of the destination, not its URL', async () => {
    streams = [
      makeStream({ id: 'a', name: 'Active one', status: 'active', deliveredCount: 1234, lastDeliveredAt: '2026-11-08T10:00:00.000Z' }),
      makeStream({ id: 'b', name: 'Paused one', status: 'paused' }),
      makeStream({
        id: 'c',
        name: 'Off one',
        status: 'disabled',
        consecutiveFailures: 20,
        lastError: 'HTTP 503: unavailable',
        url: 'https://logs.example.org/ingest/secret-path',
      }),
    ];
    render();

    expect(await screen.findByText('Active one')).toBeInTheDocument();
    expect(screen.getByText(ts.status.active)).toBeInTheDocument();
    expect(screen.getByText(ts.status.paused)).toBeInTheDocument();
    expect(screen.getByText(ts.status.disabled)).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.getAllByText(ts.never)).toHaveLength(2);
    expect(screen.getByText(ts.lastError.replace('{error}', 'HTTP 503: unavailable'))).toBeInTheDocument();
    expect(screen.getByText(ts.disabledHint.replace('{count}', '20'))).toBeInTheDocument();
    expect(screen.getAllByText('splunk.example.com:8088').length).toBeGreaterThan(0);
    expect(screen.getByText('logs.example.org')).toBeInTheDocument();
    expect(screen.queryByText(/secret-path/)).not.toBeInTheDocument();
  });

  it('disables Add stream at the limit and says why', async () => {
    streams = Array.from({ length: MAX_AUDIT_LOG_STREAMS }, (_, i) => makeStream({ id: `s${i}`, name: `Stream ${i}` }));
    render();

    expect(await screen.findByText('Stream 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ts.add })).toBeDisabled();
    expect(screen.getByText(ts.limitReached.replace('{max}', String(MAX_AUDIT_LOG_STREAMS)))).toBeInTheDocument();
  });

  it('says so, and offers a retry, when the streams cannot be loaded', async () => {
    const user = userEvent.setup();
    api.auditLogStreams.list = vi.fn().mockRejectedValueOnce(refusal(500, 'boom')).mockResolvedValue(answer(streams));
    render();

    expect(await screen.findByText(ts.loadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ts.retry }));
    expect(await screen.findByText(ts.empty.title)).toBeInTheDocument();
  });
});

describe('LogStreamingSection actions', () => {
  it('shows the result of a test event inline: success with status and duration', async () => {
    const user = userEvent.setup();
    streams = [makeStream()];
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.test);

    expect(api.auditLogStreams.test).toHaveBeenCalledWith('als_1');
    expect(await screen.findByText(ts.test.success.replace('{status}', '200').replace('{duration}', '42'))).toBeInTheDocument();
  });

  it('shows the error of a refused test event inline', async () => {
    const user = userEvent.setup();
    streams = [makeStream()];
    api.auditLogStreams.test = vi.fn(async () => ({
      data: { ok: false, status: null, error: 'Private or local addresses are not allowed', durationMs: 3 },
    }));
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.test);

    expect(
      await screen.findByText(ts.test.failure.replace('{error}', 'Private or local addresses are not allowed')),
    ).toBeInTheDocument();
  });

  it('pauses an active stream, resumes a paused one and switches a disabled one back on', async () => {
    const user = userEvent.setup();
    streams = [
      makeStream({ id: 'a', name: 'Active one', status: 'active' }),
      makeStream({ id: 'b', name: 'Paused one', status: 'paused' }),
      makeStream({ id: 'c', name: 'Off one', status: 'disabled', consecutiveFailures: 20 }),
    ];
    render();
    await screen.findByText('Active one');

    await rowAction(user, 'Active one', ts.actions.pause);
    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalledWith('a', { status: 'paused' }));
    await rowAction(user, 'Paused one', ts.actions.resume);
    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalledWith('b', { status: 'active' }));
    await rowAction(user, 'Off one', ts.actions.switchOn);
    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalledWith('c', { status: 'active' }));
  });

  it('asks before deleting, and deletes on confirm', async () => {
    const user = userEvent.setup();
    streams = [makeStream()];
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.delete);
    expect(api.auditLogStreams.delete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: ts.deleteDialog.confirm }));

    await waitFor(() => expect(api.auditLogStreams.delete).toHaveBeenCalledWith('als_1'));
    expect(toast.success).toHaveBeenCalledWith(ts.messages.deleted);
  });
});

describe('LogStreamingSection form', () => {
  it('validates the name and the URL before anything is sent', async () => {
    const user = userEvent.setup();
    render();
    await user.click((await screen.findAllByRole('button', { name: ts.add }))[0]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: ts.form.create }));

    expect(await within(dialog).findByText(ts.form.nameRequired)).toBeInTheDocument();
    expect(within(dialog).getByText(ts.form.urlRequired)).toBeInTheDocument();
    expect(api.auditLogStreams.create).not.toHaveBeenCalled();
  });

  it('creates a Splunk stream with its token and the settings that were filled in', async () => {
    const user = userEvent.setup();
    render();
    await user.click((await screen.findAllByRole('button', { name: ts.add }))[0]);
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(ts.form.name), 'Prod Splunk');
    await user.type(within(dialog).getByLabelText(ts.form.url), 'https://splunk.example.com:8088/services/collector/event');
    await user.type(within(dialog).getByLabelText(new RegExp(`^${ts.form.token}`)), 'hec-token');
    await user.type(within(dialog).getByLabelText(ts.form.index), 'audit');
    await user.click(within(dialog).getByRole('button', { name: ts.form.create }));

    await waitFor(() =>
      expect(api.auditLogStreams.create).toHaveBeenCalledWith({
        name: 'Prod Splunk',
        type: 'splunk_hec',
        url: 'https://splunk.example.com:8088/services/collector/event',
        token: 'hec-token',
        settings: { index: 'audit' },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(ts.messages.created);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('creates an HTTP stream with an auth header and the line format, and shows the password field masked', async () => {
    const user = userEvent.setup();
    render();
    await user.click((await screen.findAllByRole('button', { name: ts.add }))[0]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('combobox', { name: ts.form.type }));
    await user.click(await screen.findByRole('option', { name: ts.types.http }));
    expect(within(dialog).queryByLabelText(ts.form.index)).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(ts.form.name), 'Collector');
    await user.type(within(dialog).getByLabelText(ts.form.url), 'https://logs.example.com/ingest');
    const token = within(dialog).getByLabelText(new RegExp(`^${ts.form.token}`));
    expect(token).toHaveAttribute('type', 'password');
    await user.type(token, 'Bearer abc');
    await user.type(within(dialog).getByLabelText(ts.form.authHeader), 'X-Api-Key');
    await user.click(within(dialog).getByRole('combobox', { name: ts.form.format }));
    await user.click(await screen.findByRole('option', { name: ts.form.formats.ndjson }));
    await user.click(within(dialog).getByRole('button', { name: ts.form.create }));

    await waitFor(() =>
      expect(api.auditLogStreams.create).toHaveBeenCalledWith({
        name: 'Collector',
        type: 'http',
        url: 'https://logs.example.com/ingest',
        token: 'Bearer abc',
        settings: { authHeader: 'X-Api-Key', format: 'ndjson' },
      }),
    );
  });

  it('puts the API refusal of the URL on the URL field', async () => {
    const user = userEvent.setup();
    api.auditLogStreams.create = vi.fn().mockRejectedValue(refusal(400, 'Private or local addresses are not allowed', { field: 'url' }));
    render();
    await user.click((await screen.findAllByRole('button', { name: ts.add }))[0]);
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(ts.form.name), 'Local');
    await user.type(within(dialog).getByLabelText(ts.form.url), 'https://localhost/ingest');
    await user.click(within(dialog).getByRole('button', { name: ts.form.create }));

    const message = await within(dialog).findByText('Private or local addresses are not allowed');
    expect(message).toHaveAttribute('data-slot', 'form-message');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('explains the limit when the API answers 409', async () => {
    const user = userEvent.setup();
    api.auditLogStreams.create = vi.fn().mockRejectedValue(refusal(409, 'At most 5', { limit: 5 }));
    render();
    await user.click((await screen.findAllByRole('button', { name: ts.add }))[0]);
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(ts.form.name), 'Sixth');
    await user.type(within(dialog).getByLabelText(ts.form.url), 'https://logs.example.com/ingest');
    await user.click(within(dialog).getByRole('button', { name: ts.form.create }));

    expect(await within(dialog).findByText(ts.messages.limit.replace('{max}', '5'))).toBeInTheDocument();
  });

  it('edits without touching the saved token, and never shows it', async () => {
    const user = userEvent.setup();
    streams = [makeStream({ settings: { index: 'audit' } })];
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.edit);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ts.form.tokenSaved)).toBeInTheDocument();
    // The token is not an input at all until the member chooses to replace it.
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    const name = within(dialog).getByLabelText(ts.form.name);
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: ts.form.save }));

    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalled());
    const [id, body] = api.auditLogStreams.update.mock.calls[0];
    expect(id).toBe('als_1');
    expect(body).toEqual({
      name: 'Renamed',
      type: 'splunk_hec',
      url: 'https://splunk.example.com:8088/services/collector/event',
      settings: { index: 'audit' },
    });
    expect('token' in body).toBe(false);
  });

  it('replaces the saved token with a typed one', async () => {
    const user = userEvent.setup();
    streams = [makeStream()];
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.edit);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: ts.form.tokenReplace }));
    await user.type(within(dialog).getByLabelText(new RegExp(`^${ts.form.token}`)), 'fresh');
    await user.click(within(dialog).getByRole('button', { name: ts.form.save }));

    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalled());
    expect(api.auditLogStreams.update.mock.calls[0][1]).toMatchObject({ token: 'fresh' });
  });

  it('sends null to remove the saved token', async () => {
    const user = userEvent.setup();
    streams = [makeStream()];
    render();
    await screen.findByText('Production Splunk');

    await rowAction(user, 'Production Splunk', ts.actions.edit);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: ts.form.tokenRemove }));
    expect(within(dialog).getByText(ts.form.tokenWillRemove)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ts.form.save }));

    await waitFor(() => expect(api.auditLogStreams.update).toHaveBeenCalled());
    expect(api.auditLogStreams.update.mock.calls[0][1]).toMatchObject({ token: null });
  });
});
