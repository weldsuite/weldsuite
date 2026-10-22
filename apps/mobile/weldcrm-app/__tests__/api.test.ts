import { api, companyPayload, personPayload, setActiveWorkspaceId } from '@/services/api';
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

const list = (data: unknown[], totalCount = data.length, cursor: string | null = null) => ({
  data,
  pagination: { totalCount, hasMore: cursor !== null, cursor },
});

describe('payload builders', () => {
  it('maps a person onto the people schema and links the company as primary', () => {
    expect(
      personPayload({ firstName: ' Jane ', jobTitle: 'CTO', phone: '123', mobile: '456', companyId: 'cmp_1' }),
    ).toEqual({
      firstName: 'Jane',
      title: 'CTO',
      directPhone: '123',
      mobilePhone: '456',
      companyIds: ['cmp_1'],
      primaryCompanyId: 'cmp_1',
    });
  });

  it('leaves out fields that were not given', () => {
    expect(personPayload({})).toEqual({});
    expect(companyPayload({ name: ' Acme ' })).toEqual({ name: 'Acme' });
  });
});

describe('getCrmDashboardStats', () => {
  const mockDashboard = (won: { pages: { amount: string; currency: string | null }[][]; totalCount: number }) => {
    let wonPage = 0;
    client.get.mockImplementation((path: string) => {
      if (path.startsWith('/workspace-settings')) return Promise.resolve({ data: { currency: 'EUR' } });
      if (path.startsWith('/people')) return Promise.resolve(list([], 42));
      if (path.startsWith('/companies')) return Promise.resolve(list([], 7));
      if (path.startsWith('/leads') && path.includes('status=new')) return Promise.resolve(list([], 5));
      if (path.startsWith('/leads') && path.includes('status=converted')) return Promise.resolve(list([], 2));
      if (path.startsWith('/leads')) return Promise.resolve(list([], 10));
      if (path.startsWith('/opportunities')) {
        const rows = won.pages[wonPage] ?? [];
        wonPage += 1;
        const next = wonPage < won.pages.length ? `cursor_${wonPage}` : null;
        return Promise.resolve(list(rows, won.totalCount, next));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
  };

  it('sums won deals across every page, only in the workspace currency', async () => {
    mockDashboard({
      pages: [
        [
          { amount: '1000.00', currency: 'EUR' },
          { amount: '500.00', currency: 'USD' },
        ],
        [{ amount: '250.50', currency: 'EUR' }],
      ],
      totalCount: 3,
    });

    const res = await api.getCrmDashboardStats();

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      totalPeople: 42,
      totalCompanies: 7,
      newLeads: 5,
      conversionRate: 20,
      wonDeals: 3,
      revenue: 1250.5,
      currency: 'EUR',
      revenueExcluded: 1,
      revenuePartial: false,
      revenueDealsRead: 3,
    });
  });

  it('has no fake trend figures', async () => {
    mockDashboard({ pages: [[]], totalCount: 0 });
    const res = await api.getCrmDashboardStats();
    expect(res.data?.peopleChange).toBeUndefined();
    expect(res.data?.revenueChange).toBeUndefined();
    expect(res.data?.leadsChange).toBeUndefined();
    expect(res.data?.conversionRateChange).toBeUndefined();
  });

  it('reports a failure instead of throwing', async () => {
    client.get.mockRejectedValue(new Error('offline'));
    const res = await api.getCrmDashboardStats();
    expect(res).toEqual({ success: false, error: 'offline' });
  });
});

describe('people and companies', () => {
  it('lists people the way the platform grid does (CRM members only) and maps rows', async () => {
    client.get.mockResolvedValue(
      list(
        [
          {
            id: 'per_1',
            displayName: 'Jane Doe',
            firstName: 'Jane',
            title: 'CTO',
            email: 'jane@acme.com',
            directPhone: '123',
            status: 'active',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-02',
          },
        ],
        1,
      ),
    );

    const res = await api.getPeople({ search: ' jane ' });

    expect(client.get).toHaveBeenCalledWith('/people?limit=25&search=jane&inCrm=true');
    expect(res.data?.items[0]).toMatchObject({ id: 'per_1', name: 'Jane Doe', jobTitle: 'CTO', phone: '123' });
  });

  it('passes the cursor for the next page', async () => {
    client.get.mockResolvedValue(list([], 0));
    await api.getCompanies({ cursor: 'cmp_9' });
    expect(client.get).toHaveBeenCalledWith('/companies?limit=25&cursor=cmp_9');
  });

  it('maps the company-people link rows', async () => {
    client.get.mockResolvedValue({
      data: [
        { id: 'l1', personId: 'per_1', role: 'CEO', isPrimary: true, person: { id: 'per_1', displayName: 'Jane Doe', email: 'j@a.com' } },
      ],
    });
    const res = await api.getCompanyPeople('cmp_1');
    expect(client.get).toHaveBeenCalledWith('/companies/cmp_1/people');
    expect(res.data).toEqual([
      { linkId: 'l1', personId: 'per_1', name: 'Jane Doe', email: 'j@a.com', role: 'CEO', isPrimary: true },
    ]);
  });

  it('creates and deletes through the matching endpoints', async () => {
    client.post.mockResolvedValue({ data: { id: 'cmp_2' } });
    client.delete.mockResolvedValue({});
    expect((await api.createCompany({ name: 'Acme' })).data).toEqual({ id: 'cmp_2' });
    expect(client.post).toHaveBeenCalledWith('/companies', { name: 'Acme' });
    expect((await api.deletePerson('per_1')).success).toBe(true);
    expect(client.delete).toHaveBeenCalledWith('/people/per_1');
  });

  it('surfaces the server message when a create is refused', async () => {
    client.post.mockRejectedValue(new Error('A person with this email already exists'));
    const res = await api.createPerson({ firstName: 'Jane', email: 'jane@acme.com' });
    expect(res).toEqual({ success: false, error: 'A person with this email already exists' });
  });
});

describe('tasks', () => {
  it('creates a task as an activity with the mapped status', async () => {
    client.post.mockResolvedValue({ data: { id: 'act_1' } });
    const res = await api.createCrmTask({ title: ' Call Acme ', status: 'in-progress', dueDate: '2026-08-05T12:00:00.000Z' });
    expect(client.post).toHaveBeenCalledWith('/activities', {
      type: 'task',
      subject: 'Call Acme',
      description: undefined,
      status: 'in_progress',
      dueDate: '2026-08-05T12:00:00.000Z',
    });
    expect(res.data).toMatchObject({ id: 'act_1', title: 'Call Acme', status: 'in-progress', completed: false });
  });

  it('updates title, status and due date, then re-reads the task', async () => {
    client.patch.mockResolvedValue({ data: { id: 'act_1' } });
    client.get.mockResolvedValue({
      data: { id: 'act_1', type: 'task', subject: 'New title', status: 'completed', dueDate: '2026-08-06T12:00:00.000Z', createdAt: 'x' },
    });
    const res = await api.updateCrmTask('act_1', { title: 'New title', status: 'done', dueDate: '2026-08-06T12:00:00.000Z' });
    expect(client.patch).toHaveBeenCalledWith('/activities/act_1', {
      subject: 'New title',
      status: 'completed',
      dueDate: '2026-08-06T12:00:00.000Z',
    });
    expect(res.data).toMatchObject({ title: 'New title', status: 'done', completed: true });
  });

  it('toggles completion without touching other fields', async () => {
    client.patch.mockResolvedValue({ data: { id: 'act_1' } });
    client.get.mockResolvedValue({ data: { id: 'act_1', type: 'task', subject: 's', status: 'planned', createdAt: 'x' } });
    await api.updateCrmTask('act_1', { completed: false });
    expect(client.patch).toHaveBeenCalledWith('/activities/act_1', { status: 'planned' });
  });

  it('deletes a task', async () => {
    client.delete.mockResolvedValue({});
    expect((await api.deleteCrmTask('act_1')).success).toBe(true);
    expect(client.delete).toHaveBeenCalledWith('/activities/act_1');
  });
});

describe('deals and activities', () => {
  it('creates a deal against a company id, in the given currency', async () => {
    client.post.mockResolvedValue({ data: { id: 'opp_1' } });
    const res = await api.createDeal({
      name: ' Q4 ',
      companyId: 'cmp_1',
      amount: 5000,
      currency: 'GBP',
      stageId: 'stg_1',
      pipelineId: 'pl_1',
    });
    expect(client.post).toHaveBeenCalledWith(
      '/opportunities',
      expect.objectContaining({ name: 'Q4', customerId: 'cmp_1', amount: 5000, currency: 'GBP', stageId: 'stg_1', pipeline: 'pl_1' }),
    );
    expect(res.data).toMatchObject({ id: 'opp_1', companyId: 'cmp_1', value: '5000', currency: 'GBP' });
  });

  it('logs an activity as completed and links the company', async () => {
    client.post.mockResolvedValue({ data: { id: 'act_2' } });
    await api.logActivity({ type: 'call', subject: ' Intro ', companyId: 'cmp_1' });
    expect(client.post).toHaveBeenCalledWith(
      '/activities',
      expect.objectContaining({ type: 'call', subject: 'Intro', status: 'completed', customerId: 'cmp_1' }),
    );
  });

  it('creates a lead with the email and a mobile source', async () => {
    client.post.mockResolvedValue({ data: { id: 'lead_1' } });
    await api.createLead({ email: ' lead@acme.com ', firstName: 'Lee' });
    expect(client.post).toHaveBeenCalledWith(
      '/leads',
      expect.objectContaining({ email: 'lead@acme.com', firstName: 'Lee', source: 'mobile' }),
    );
  });
});

describe('getWorkspaceCurrency', () => {
  const settings = (currency: string | null) => Promise.resolve({ data: { currency } });

  beforeEach(() => {
    client.get.mockReset();
    setActiveWorkspaceId(null);
  });

  it('reads the currency once per workspace', async () => {
    setActiveWorkspaceId('org_a');
    client.get.mockImplementation(() => settings('USD'));
    expect(await api.getWorkspaceCurrency()).toBe('USD');
    expect(await api.getWorkspaceCurrency()).toBe('USD');
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('does not reuse one workspace currency for another', async () => {
    setActiveWorkspaceId('org_b');
    client.get.mockImplementation(() => settings('GBP'));
    expect(await api.getWorkspaceCurrency()).toBe('GBP');

    setActiveWorkspaceId('org_c');
    client.get.mockImplementation(() => settings('CHF'));
    expect(await api.getWorkspaceCurrency()).toBe('CHF');

    setActiveWorkspaceId('org_b');
    expect(await api.getWorkspaceCurrency()).toBe('GBP');
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('does not keep an answer while signed out', async () => {
    client.get.mockImplementation(() => settings('USD'));
    expect(await api.getWorkspaceCurrency()).toBe('USD');
    client.get.mockImplementation(() => settings('SEK'));
    expect(await api.getWorkspaceCurrency()).toBe('SEK');
  });

  it('drops an answer that arrives after the workspace changed', async () => {
    setActiveWorkspaceId('org_d');
    client.get.mockImplementationOnce(() => {
      setActiveWorkspaceId('org_e');
      return settings('JPY');
    });
    expect(await api.getWorkspaceCurrency()).toBe('JPY');

    setActiveWorkspaceId('org_d');
    client.get.mockImplementation(() => settings('NOK'));
    expect(await api.getWorkspaceCurrency()).toBe('NOK');
  });

  it('falls back to EUR when the settings cannot be read', async () => {
    setActiveWorkspaceId('org_f');
    client.get.mockRejectedValue(new Error('offline'));
    expect(await api.getWorkspaceCurrency()).toBe('EUR');
  });
});
