import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { update: vi.fn(), send: vi.fn() } }));
const state = vi.hoisted(() => ({
  permissions: new Set<string>(['sign_envelopes:send']),
  folders: [] as { id: string; name: string; parentId: string | null; accessRole?: string }[],
  /** The `enabled` of every call to the folder hook. */
  folderLookups: [] as boolean[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-drive-queries', () => ({
  useAllDriveFolders: (enabled = true) => {
    state.folderLookups.push(enabled);
    return { data: enabled ? { success: true, data: state.folders } : undefined, isLoading: false, isError: false };
  },
}));

import { ReviewStep } from './review-step';

const tr = en.weldsign.editor.review;

const ann = { id: 'rcp_ann', role: 'signer', roleName: null, name: 'Ann', email: 'ann@example.com' } as SignRecipientDto;
const signature = { id: 'f_1', recipientId: 'rcp_ann', type: 'signature' } as SignFieldDto;

/** A draft that can be sent as it is. */
function ready(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Agreement',
    status: 'draft',
    message: null,
    signingOrderEnabled: false,
    reminderAfterDays: null,
    reminderEveryDays: null,
    reminderMaxCount: null,
    documents: [{ id: 'sgd_1', name: 'Agreement.pdf' }],
    recipientList: [ann],
    fields: [signature],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(envelope: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReviewStep envelope={envelope} editable={editable} />
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
  state.permissions = new Set(['sign_envelopes:send']);
  state.folders = [];
  state.folderLookups = [];
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.update.mockResolvedValue({ data: ready() });
  api.weldsign.send.mockResolvedValue({ data: ready({ status: 'sent' }) });
});

afterEach(() => cleanup());

describe('review step', () => {
  it('saves the message through the request API', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.type(screen.getByLabelText(tr.message), 'Please sign.');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { message: 'Please sign.' }));
  });

  it('turns reminders on with defaults', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('switch', { name: new RegExp(tr.reminders) }));
    await waitFor(() =>
      expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }),
    );
  });

  it('saves a changed reminder setting, within its limits', async () => {
    const user = userEvent.setup();
    renderStep(ready({ reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }));
    const after = screen.getByLabelText(tr.reminderAfter);
    await user.clear(after);
    await user.type(after, '200');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { reminderAfterDays: 90 }));
  });

  it('counts documents, recipients and fields', () => {
    renderStep(ready());
    const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(stat(tr.summaryDocuments)).toBe('1');
    expect(stat(tr.summaryRecipients)).toBe('1');
    expect(stat(tr.summaryFields)).toBe('1');
  });

  it('says what stops the draft from being sent, naming the person', () => {
    renderStep(ready({ fields: [], documents: [] }));
    expect(screen.getByText(tr.noDocuments)).toBeInTheDocument();
    expect(screen.getByText('Ann has no signature field.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.send })).toBeDisabled();
  });

  it('says when nothing does', () => {
    renderStep(ready());
    expect(screen.getByText(tr.ready)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.send })).toBeEnabled();
  });

  it('hides Send without sign_envelopes:send, and when the draft cannot be changed', () => {
    state.permissions = new Set();
    renderStep(ready());
    expect(screen.queryByRole('button', { name: tr.send })).toBeNull();
    cleanup();

    state.permissions = new Set(['sign_envelopes:send']);
    renderStep(ready(), false);
    expect(screen.queryByRole('button', { name: tr.send })).toBeNull();
    expect(screen.getByLabelText(tr.message)).toBeDisabled();
  });

  it('asks for the expiry, then sends the draft', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('button', { name: tr.send }));
    expect(screen.getByText(tr.sendTitle)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: tr.sendConfirm }));
    await waitFor(() => expect(api.weldsign.send).toHaveBeenCalledTimes(1));
    expect(api.weldsign.send.mock.calls[0]![0]).toBe('sgn_1');
    expect(api.weldsign.send.mock.calls[0]![1]).toEqual({ expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(tr.sent));
  });

  describe('signed copy', () => {
    const ts = tr.signedCopy;
    const year = new Date().getFullYear();
    const folders = [
      { id: 'fld_contracts', name: 'Contracts', parentId: null, accessRole: 'owner' },
      { id: 'fld_2026', name: '2026', parentId: 'fld_contracts', accessRole: 'editor' },
    ];
    const withFolders = () => {
      state.folders = folders;
      state.permissions = new Set(['sign_envelopes:send', 'folders:read']);
    };
    const section = () => screen.getByRole('region', { name: ts.title });

    it('says the signed PDF goes to WeldSign/<year> in the sender\'s own WeldDrive by default', () => {
      withFolders();
      renderStep(ready({ fileBackFolderId: null }));
      expect(within(section()).getByText(`Saved in WeldSign/${year} in your WeldDrive, a folder only you can see.`)).toBeInTheDocument();
      expect(within(section()).getByRole('button', { name: ts.change })).toBeInTheDocument();
      // Already the default: nothing to go back to, and no need to look up a folder.
      expect(within(section()).queryByRole('button', { name: ts.useDefault })).toBeNull();
      expect(state.folderLookups.every((enabled) => !enabled)).toBe(true);
    });

    it('names the folder that was chosen', () => {
      withFolders();
      renderStep(ready({ fileBackFolderId: 'fld_2026' }));
      expect(within(section()).getByText('Saved in the folder "2026" in WeldDrive.')).toBeInTheDocument();
      expect(within(section()).getByRole('button', { name: ts.useDefault })).toBeInTheDocument();
    });

    it('still says a folder was chosen when its name is not known (no access to folders, or it is gone)', () => {
      withFolders();
      renderStep(ready({ fileBackFolderId: 'fld_gone' }));
      expect(within(section()).getByText(ts.toFolderUnknown)).toBeInTheDocument();
      cleanup();

      state.permissions = new Set(['sign_envelopes:send']);
      renderStep(ready({ fileBackFolderId: 'fld_2026' }));
      expect(within(section()).getByText(ts.toFolderUnknown)).toBeInTheDocument();
      // Without folders:read the folder can not be changed, only given up.
      expect(within(section()).queryByRole('button', { name: ts.change })).toBeNull();
      expect(within(section()).getByRole('button', { name: ts.useDefault })).toBeInTheDocument();
    });

    it('picks another folder through the WeldDrive folder picker', async () => {
      withFolders();
      api.weldsign.update.mockResolvedValue({ data: ready({ fileBackFolderId: 'fld_2026' }) });
      const user = userEvent.setup();
      renderStep(ready({ fileBackFolderId: null }));

      await user.click(within(section()).getByRole('button', { name: ts.change }));
      const dialog = await screen.findByRole('dialog', { name: ts.pickTitle });
      expect(within(dialog).getByText(ts.pickDescription)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: '2026' }));
      await user.click(within(dialog).getByRole('button', { name: ts.pickConfirm }));

      await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { fileBackFolderId: 'fld_2026' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('goes back to the default place', async () => {
      withFolders();
      api.weldsign.update.mockResolvedValue({ data: ready({ fileBackFolderId: null }) });
      const user = userEvent.setup();
      renderStep(ready({ fileBackFolderId: 'fld_contracts' }));

      await user.click(within(section()).getByRole('button', { name: ts.useDefault }));

      await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { fileBackFolderId: null }));
    });

    it('says why the folder could not be changed', async () => {
      withFolders();
      api.weldsign.update.mockRejectedValue(new ApiError('You cannot add files to that folder', 403));
      const user = userEvent.setup();
      renderStep(ready({ fileBackFolderId: 'fld_contracts' }));

      await user.click(within(section()).getByRole('button', { name: ts.useDefault }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${ts.saveFailed}: You cannot add files to that folder`));
    });

    it('shows where it goes, but no way to change it, on a request that cannot be changed', () => {
      withFolders();
      renderStep(ready({ fileBackFolderId: 'fld_2026' }), false);
      expect(within(section()).getByText('Saved in the folder "2026" in WeldDrive.')).toBeInTheDocument();
      expect(within(section()).queryByRole('button')).toBeNull();
    });
  });

  describe('source', () => {
    const sectionOf = () => screen.getByRole('region', { name: tr.signedCopy.title });

    it('links a WeldDrive file to its preview in WeldDrive', () => {
      renderStep(ready({ source: { entityType: 'file', entityId: 'fil_1', name: 'Service agreement.pdf' } }));
      expect(within(sectionOf()).getByText(/^From/)).toBeInTheDocument();
      expect(within(sectionOf()).getByRole('link', { name: 'Service agreement.pdf' })).toHaveAttribute('href', '/welddrive?file=fil_1');
      // A file is not a CRM record: nothing is also saved on it.
      expect(within(sectionOf()).queryByText(/also saved/)).toBeNull();
    });

    it('links a company and a person to the CRM, and says the signed copy is also saved on them', () => {
      renderStep(ready({ source: { entityType: 'company', entityId: 'cus_1', name: 'Acme BV' } }));
      expect(within(sectionOf()).getByRole('link', { name: 'Acme BV' })).toHaveAttribute('href', '/weldcrm/companies?stack=company:cus_1:panel');
      expect(within(sectionOf()).getByText('A copy is also saved on the files of Acme BV, with a note in its activity.')).toBeInTheDocument();
      cleanup();

      renderStep(ready({ source: { entityType: 'person', entityId: 'per_1', name: 'Ann Lee' } }));
      expect(within(sectionOf()).getByRole('link', { name: 'Ann Lee' })).toHaveAttribute('href', '/weldcrm/people?stack=person:per_1:panel');
      expect(within(sectionOf()).getByText(/^A copy is also saved on the files of Ann Lee/)).toBeInTheDocument();
    });

    it('links an opportunity, and says the copy goes to its company', () => {
      renderStep(ready({ source: { entityType: 'opportunity', entityId: 'opp_1', name: 'Website rebuild' } }));
      expect(within(sectionOf()).getByRole('link', { name: 'Website rebuild' })).toHaveAttribute('href', '/weldcrm?entity=opportunity:opp_1');
      expect(
        within(sectionOf()).getByText("A copy is also saved on the files of the opportunity's company, with a note on Website rebuild."),
      ).toBeInTheDocument();
    });

    it('says so, without a link, when the file or record has been deleted since', () => {
      renderStep(ready({ source: { entityType: 'company', entityId: 'cus_1', name: null } }));
      expect(within(sectionOf()).getByText('From a company that was deleted')).toBeInTheDocument();
      expect(within(sectionOf()).queryByRole('link')).toBeNull();
    });

    it('shows nothing about a source when the draft has none', () => {
      renderStep(ready({ source: null }));
      expect(within(sectionOf()).queryByText(/^From/)).toBeNull();
      expect(within(sectionOf()).queryByRole('link')).toBeNull();
    });
  });

  it('shows the server\'s reason when sending fails', async () => {
    api.weldsign.send.mockRejectedValue(new ApiError('Daily email limit reached', 400));
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('button', { name: tr.send }));
    await user.click(screen.getByRole('button', { name: tr.sendConfirm }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${tr.sendFailed}: Daily email limit reached`));
  });
});
