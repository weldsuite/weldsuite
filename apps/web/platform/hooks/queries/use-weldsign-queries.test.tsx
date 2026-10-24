import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { SignEnvelopeDetail, SignFieldDto } from '@weldsuite/app-api-client/schemas/weldsign';

/** The calls an envelope and a template have in common; the editor's steps use them through a target. */
function sharedCalls() {
  return {
    uploadDocument: vi.fn(),
    documentContent: vi.fn(),
    reorderDocuments: vi.fn(),
    removeDocument: vi.fn(),
    replaceFields: vi.fn(),
    update: vi.fn(),
  };
}

const api = vi.hoisted(() => ({ weldsign: {} as Record<string, unknown> }));
const calls = vi.hoisted(() => ({ envelope: {} as ReturnType<typeof sharedCalls>, template: {} as ReturnType<typeof sharedCalls> }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import {
  envelopeTarget,
  signTargetKey,
  targetOf,
  templateTarget,
  useSaveSignFields,
  useSignDocumentContent,
  useSignDocumentMutations,
  useSignTemplateRoleMutations,
  useUpdateSignEnvelope,
  useUseSignTemplate,
  weldsignKeys,
} from './use-weldsign-queries';

const templateOnly = {
  addRole: vi.fn(),
  updateRole: vi.fn(),
  removeRole: vi.fn(),
  use: vi.fn(),
};

function detail(overrides: Partial<SignEnvelopeDetail>): SignEnvelopeDetail {
  return { id: 'sgn_1', kind: 'envelope', fields: [], documents: [], recipientList: [], ...overrides } as unknown as SignEnvelopeDetail;
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated };
}

beforeEach(() => {
  calls.envelope = sharedCalls();
  calls.template = sharedCalls();
  for (const fn of Object.values(templateOnly)) fn.mockReset();
  api.weldsign = { ...calls.envelope, templates: { ...calls.template, ...templateOnly } };
});

describe('targets', () => {
  it('say which API and which cache entry a detail belongs to', () => {
    expect(targetOf(detail({ id: 'sgn_1', kind: 'envelope' }))).toEqual({ kind: 'envelope', id: 'sgn_1' });
    expect(targetOf(detail({ id: 'sgt_1', kind: 'template' }))).toEqual({ kind: 'template', id: 'sgt_1' });
    expect(signTargetKey(envelopeTarget('sgn_1'))).toEqual(weldsignKeys.envelope('sgn_1'));
    expect(signTargetKey(templateTarget('sgt_1'))).toEqual(weldsignKeys.template('sgt_1'));
  });

  it('keep templates under the root the realtime sync refreshes, apart from the request lists', () => {
    expect(weldsignKeys.template('sgt_1').slice(0, 1)).toEqual(weldsignKeys.all);
    expect(weldsignKeys.templateLists().slice(0, 1)).toEqual(weldsignKeys.all);
    expect(weldsignKeys.templateLists()).not.toEqual(weldsignKeys.lists());
  });
});

describe('document mutations', () => {
  const file = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' });

  it('still serve a request: its API, its entry, its lists', async () => {
    calls.envelope.uploadDocument.mockResolvedValue({ data: { id: 'sgd_1' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useSignDocumentMutations(envelopeTarget('sgn_1')), { wrapper });

    await result.current.upload.mutateAsync(file);

    expect(calls.envelope.uploadDocument).toHaveBeenCalledWith('sgn_1', file);
    expect(calls.template.uploadDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidated()).toEqual([weldsignKeys.envelope('sgn_1'), weldsignKeys.lists()]));
  });

  it('serve a template through the template API', async () => {
    calls.template.uploadDocument.mockResolvedValue({ data: { id: 'sgd_1' } });
    calls.template.reorderDocuments.mockResolvedValue({ data: [] });
    calls.template.removeDocument.mockResolvedValue(undefined);
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useSignDocumentMutations(templateTarget('sgt_1')), { wrapper });

    await result.current.upload.mutateAsync(file);
    await result.current.reorder.mutateAsync(['sgd_2', 'sgd_1']);
    await result.current.remove.mutateAsync('sgd_2');

    expect(calls.template.uploadDocument).toHaveBeenCalledWith('sgt_1', file);
    expect(calls.template.reorderDocuments).toHaveBeenCalledWith('sgt_1', { documentIds: ['sgd_2', 'sgd_1'] });
    expect(calls.template.removeDocument).toHaveBeenCalledWith('sgt_1', 'sgd_2');
    expect(calls.envelope.uploadDocument).not.toHaveBeenCalled();
    expect(calls.envelope.reorderDocuments).not.toHaveBeenCalled();
    // Only the template and the template list refresh, once per change: no request list is touched.
    const refreshed = [weldsignKeys.template('sgt_1'), weldsignKeys.templateLists()];
    await waitFor(() => expect(invalidated()).toEqual([...refreshed, ...refreshed, ...refreshed]));
  });
});

describe('useSaveSignFields', () => {
  const saved = [{ id: 'sgf_1', type: 'signature' }] as unknown as SignFieldDto[];

  it('saves a request through the request API and updates its cached detail', async () => {
    calls.envelope.replaceFields.mockResolvedValue({ data: saved });
    const { client, wrapper } = setup();
    client.setQueryData(weldsignKeys.envelope('sgn_1'), { data: detail({ id: 'sgn_1', fields: [] }) });
    const { result } = renderHook(() => useSaveSignFields(envelopeTarget('sgn_1')), { wrapper });

    await result.current.mutateAsync([]);

    expect(calls.envelope.replaceFields).toHaveBeenCalledWith('sgn_1', { fields: [] });
    expect(client.getQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.envelope('sgn_1'))?.data.fields).toEqual(saved);
  });

  it('saves a template through the template API and updates the cached template', async () => {
    calls.template.replaceFields.mockResolvedValue({ data: saved });
    const { client, wrapper } = setup();
    client.setQueryData(weldsignKeys.template('sgt_1'), { data: detail({ id: 'sgt_1', kind: 'template', fields: [] }) });
    const { result } = renderHook(() => useSaveSignFields(templateTarget('sgt_1')), { wrapper });

    await result.current.mutateAsync([]);

    expect(calls.template.replaceFields).toHaveBeenCalledWith('sgt_1', { fields: [] });
    expect(calls.envelope.replaceFields).not.toHaveBeenCalled();
    expect(client.getQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.template('sgt_1'))?.data.fields).toEqual(saved);
    expect(client.getQueryData(weldsignKeys.envelope('sgt_1'))).toBeUndefined();
  });

  it('reports a failed save through onError', async () => {
    calls.template.replaceFields.mockRejectedValue(new Error('Too many fields'));
    const onError = vi.fn();
    const { wrapper } = setup();
    const { result } = renderHook(() => useSaveSignFields(templateTarget('sgt_1'), onError), { wrapper });

    await expect(result.current.mutateAsync([])).rejects.toThrow('Too many fields');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateSignEnvelope', () => {
  it('changes a request and refreshes the request lists', async () => {
    calls.envelope.update.mockResolvedValue({ data: detail({ id: 'sgn_1', title: 'New' }) });
    const { client, wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUpdateSignEnvelope(envelopeTarget('sgn_1')), { wrapper });

    await result.current.mutateAsync({ title: 'New' });

    expect(calls.envelope.update).toHaveBeenCalledWith('sgn_1', { title: 'New' });
    expect(client.getQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.envelope('sgn_1'))?.data.title).toBe('New');
    await waitFor(() => expect(invalidated()).toEqual([weldsignKeys.lists()]));
  });

  it('changes a template and refreshes the template lists', async () => {
    calls.template.update.mockResolvedValue({ data: detail({ id: 'sgt_1', kind: 'template', title: 'NDA' }) });
    const { client, wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUpdateSignEnvelope(templateTarget('sgt_1')), { wrapper });

    await result.current.mutateAsync({ signingOrderEnabled: true });

    expect(calls.template.update).toHaveBeenCalledWith('sgt_1', { signingOrderEnabled: true });
    expect(client.getQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.template('sgt_1'))?.data.title).toBe('NDA');
    await waitFor(() => expect(invalidated()).toEqual([weldsignKeys.templateLists()]));
  });
});

describe('useSignDocumentContent', () => {
  const bytes = new ArrayBuffer(8);
  const response = { ok: true, status: 200, arrayBuffer: async () => bytes };

  it('reads a request document from the request API', async () => {
    calls.envelope.documentContent.mockResolvedValue(response);
    const { wrapper } = setup();
    const { result } = renderHook(() => useSignDocumentContent(envelopeTarget('sgn_1'), 'sgd_1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBe(bytes));
    expect(calls.envelope.documentContent).toHaveBeenCalledWith('sgn_1', 'sgd_1');
    expect(calls.template.documentContent).not.toHaveBeenCalled();
  });

  it('reads a template document from the template API', async () => {
    calls.template.documentContent.mockResolvedValue(response);
    const { wrapper } = setup();
    const { result } = renderHook(() => useSignDocumentContent(templateTarget('sgt_1'), 'sgd_9'), { wrapper });

    await waitFor(() => expect(result.current.data).toBe(bytes));
    expect(calls.template.documentContent).toHaveBeenCalledWith('sgt_1', 'sgd_9');
    expect(calls.envelope.documentContent).not.toHaveBeenCalled();
  });

  it('waits for a document to be chosen', () => {
    const { wrapper } = setup();
    renderHook(() => useSignDocumentContent(templateTarget('sgt_1'), null), { wrapper });
    expect(calls.template.documentContent).not.toHaveBeenCalled();
  });
});

describe('template roles', () => {
  it('add, change and remove a role, and refresh the template each time', async () => {
    templateOnly.addRole.mockResolvedValue({ data: { id: 'sgr_1' } });
    templateOnly.updateRole.mockResolvedValue({ data: { id: 'sgr_1' } });
    templateOnly.removeRole.mockResolvedValue(undefined);
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useSignTemplateRoleMutations('sgt_1'), { wrapper });

    await result.current.add.mutateAsync({ roleName: 'Client' });
    await result.current.update.mutateAsync({ roleId: 'sgr_1', input: { roleName: 'Customer' } });
    await result.current.remove.mutateAsync('sgr_1');

    expect(templateOnly.addRole).toHaveBeenCalledWith('sgt_1', { roleName: 'Client' });
    expect(templateOnly.updateRole).toHaveBeenCalledWith('sgt_1', 'sgr_1', { roleName: 'Customer' });
    expect(templateOnly.removeRole).toHaveBeenCalledWith('sgt_1', 'sgr_1');
    const refreshed = [weldsignKeys.template('sgt_1'), weldsignKeys.templateLists()];
    await waitFor(() => expect(invalidated()).toEqual([...refreshed, ...refreshed, ...refreshed]));
  });
});

describe('useUseSignTemplate', () => {
  it('puts the new draft in the cache and refreshes the request lists', async () => {
    templateOnly.use.mockResolvedValue({ data: detail({ id: 'sgn_new', title: 'NDA for Acme' }) });
    const { client, wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUseSignTemplate('sgt_1'), { wrapper });

    const draft = await result.current.mutateAsync({ recipients: [{ roleId: 'sgr_1', name: 'Ann', email: 'ann@example.com' }] });

    expect(templateOnly.use).toHaveBeenCalledWith('sgt_1', { recipients: [{ roleId: 'sgr_1', name: 'Ann', email: 'ann@example.com' }] });
    expect(draft.id).toBe('sgn_new');
    expect(client.getQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.envelope('sgn_new'))?.data.title).toBe('NDA for Acme');
    await waitFor(() => expect(invalidated()).toEqual([weldsignKeys.lists()]));
  });
});
