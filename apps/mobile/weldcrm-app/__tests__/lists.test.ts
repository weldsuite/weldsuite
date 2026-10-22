import { addMembersPayload, createListPayload, listsApi, mapList, mapListMember, renameListPayload } from '@/services/lists';
import { appApiClient } from '@/services/app-api';

jest.mock('@/services/app-api', () => ({
  appApiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const client = appApiClient as unknown as {
  get: jest.Mock;
  post: jest.Mock;
  patch: jest.Mock;
  delete: jest.Mock;
};

const listRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'list_1',
  name: 'Trade show',
  kind: 'person',
  description: '  ',
  memberCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  ...overrides,
  ...overrides,
});

describe('mapList', () => {
  it('maps the row, dropping a blank description', () => {
    expect(mapList(listRow())).toEqual({
      id: 'list_1',
      name: 'Trade show',
      kind: 'person',
      description: undefined,
      memberCount: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
  });

  it('defaults to a company list with no members when the API leaves them out', () => {
    const list = mapList(listRow({ kind: undefined, memberCount: undefined, description: 'Hot ones' }));
    expect(list.kind).toBe('company');
    expect(list.memberCount).toBe(0);
    expect(list.description).toBe('Hot ones');
  });
});

describe('mapListMember', () => {
  it('names a person from the row and shows the job title', () => {
    const member = mapListMember('person', {
      memberId: 'lm_1',
      entityId: 'per_1',
      addedAt: '2026-01-03T00:00:00Z',
      entity: { displayName: 'Jane Doe', title: 'CTO', email: 'jane@acme.test' },
    });
    expect(member).toEqual({
      id: 'per_1',
      memberId: 'lm_1',
      kind: 'person',
      name: 'Jane Doe',
      subtitle: 'CTO',
      email: 'jane@acme.test',
      addedAt: '2026-01-03T00:00:00Z',
    });
  });

  it('shows a company industry, falling back to the email', () => {
    const base = { memberId: 'lm_2', entityId: 'cmp_1', addedAt: '2026-01-03T00:00:00Z' };
    expect(mapListMember('company', { ...base, entity: { name: 'Acme', industry: 'Retail' } }).subtitle).toBe('Retail');
    expect(mapListMember('company', { ...base, entity: { name: 'Acme', email: 'hi@acme.test' } }).subtitle).toBe(
      'hi@acme.test',
    );
  });
});

describe('payload builders', () => {
  it('creates static lists with a trimmed name', () => {
    expect(createListPayload({ name: '  Leads  ', kind: 'company' })).toEqual({
      name: 'Leads',
      kind: 'company',
      type: 'static',
    });
  });

  it('renames with a trimmed name and de-duplicates member ids', () => {
    expect(renameListPayload(' New ')).toEqual({ name: 'New' });
    expect(addMembersPayload(['a', 'b', 'a'])).toEqual({ entityIds: ['a', 'b'] });
  });
});

describe('listsApi', () => {
  it('lists with search, kind and cursor and returns a page', async () => {
    client.get.mockResolvedValue({
      data: [listRow()],
      pagination: { totalCount: 9, hasMore: true, cursor: 'list_1' },
    });
    const res = await listsApi.getLists({ search: ' acme ', kind: 'person', cursor: 'list_0', limit: 20 });
    expect(client.get).toHaveBeenCalledWith('/lists?limit=20&cursor=list_0&search=acme&kind=person');
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ totalCount: 9, hasMore: true, cursor: 'list_1' });
    expect(res.data?.items[0]?.name).toBe('Trade show');
  });

  it('posts a new list and returns it', async () => {
    client.post.mockResolvedValue({ data: listRow({ id: 'list_2', kind: 'company' }) });
    const res = await listsApi.createList({ name: 'Partners', kind: 'company' });
    expect(client.post).toHaveBeenCalledWith('/lists', { name: 'Partners', kind: 'company', type: 'static' });
    expect(res.data?.id).toBe('list_2');
  });

  it('renames and deletes through the list id', async () => {
    client.patch.mockResolvedValue({ data: listRow({ name: 'Renamed' }) });
    client.delete.mockResolvedValue({});
    expect((await listsApi.renameList('list_1', 'Renamed')).data?.name).toBe('Renamed');
    expect(client.patch).toHaveBeenCalledWith('/lists/list_1', { name: 'Renamed' });
    expect((await listsApi.deleteList('list_1')).success).toBe(true);
    expect(client.delete).toHaveBeenCalledWith('/lists/list_1');
  });

  it('reads members, adds by entity id and removes one', async () => {
    client.get.mockResolvedValue({
      data: [
        { memberId: 'lm_1', entityId: 'cmp_1', addedAt: '2026-01-03T00:00:00Z', entity: { displayName: 'Acme' } },
      ],
    });
    const members = await listsApi.getMembers('list_1', 'company');
    expect(client.get).toHaveBeenCalledWith('/lists/list_1/members');
    expect(members.data?.[0]).toMatchObject({ id: 'cmp_1', name: 'Acme', kind: 'company' });

    client.post.mockResolvedValue({ data: { id: 'list_1', added: 0 } });
    const added = await listsApi.addMembers('list_1', ['cmp_1']);
    expect(client.post).toHaveBeenCalledWith('/lists/list_1/members', { entityIds: ['cmp_1'] });
    expect(added.data).toEqual({ added: 0 });

    client.delete.mockResolvedValue({});
    await listsApi.removeMember('list_1', 'cmp_1');
    expect(client.delete).toHaveBeenCalledWith('/lists/list_1/members/cmp_1');
  });

  it('turns a thrown error into a failed response', async () => {
    client.get.mockRejectedValue(new Error('boom'));
    expect(await listsApi.getList('list_1')).toEqual({ success: false, error: 'boom' });
    client.delete.mockRejectedValue('nope');
    expect(await listsApi.deleteList('list_1')).toEqual({ success: false, error: 'Request failed' });
  });
});
