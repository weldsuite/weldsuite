import { api, companyPayload, dealUpdatePayload, personPayload, setActiveWorkspaceId } from '@/services/api';
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
      if (path.startsWith('/people') && path.includes('isLead=true')) return Promise.resolve(list([], 4));
      if (path.startsWith('/people')) return Promise.resolve(list([], 42));
      if (path.startsWith('/companies') && path.includes('isLead=true')) return Promise.resolve(list([], 1));
      if (path.startsWith('/companies')) return Promise.resolve(list([], 7));
      if (path.startsWith('/opportunities') && path.includes('status=open')) return Promise.resolve(list([], 9));
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
      leads: 5,
      openDeals: 9,
      wonDeals: 3,
      revenue: 1250.5,
      currency: 'EUR',
      revenueExcluded: 1,
      revenuePartial: false,
      revenueDealsRead: 3,
    });
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

  it('points at the existing person when the email is already in the CRM', async () => {
    client.post.mockRejectedValue(
      Object.assign(new Error('Email already in use'), { status: 409, body: { details: { existingPersonId: 'per_7' } } }),
    );
    const res = await api.createPerson({ firstName: 'Jane', email: 'jane@acme.com' });
    expect(res).toEqual({ success: false, error: 'Email already in use', existingPersonId: 'per_7' });
  });

  it('filters leads and suppliers with true-only flags', async () => {
    client.get.mockResolvedValue(list([], 0));
    await api.getPeople({ isLead: true });
    expect(client.get).toHaveBeenCalledWith('/people?limit=25&isLead=true&inCrm=true');
    await api.getCompanies({ isLead: false, isSupplier: true });
    expect(client.get).toHaveBeenCalledWith('/companies?limit=25&isSupplier=true');
  });

  it('archives and links through the platform endpoints', async () => {
    client.post.mockResolvedValue({ data: { id: 'cmp_1', name: 'Acme', createdAt: 'x', updatedAt: 'x', archivedAt: '2026-10-22' } });
    const archived = await api.setCompanyArchived('cmp_1', true);
    expect(client.post).toHaveBeenCalledWith('/companies/cmp_1/archive', {});
    expect(archived.data?.archivedAt).toBe('2026-10-22');

    client.post.mockResolvedValue({ data: { id: 'pc_1' } });
    await api.linkPersonToCompany({ personId: 'per_1', companyId: 'cmp_1', isPrimary: true });
    expect(client.post).toHaveBeenCalledWith('/person-companies', {
      personId: 'per_1',
      companyId: 'cmp_1',
      role: undefined,
      isPrimary: true,
    });
  });

  it('surfaces the server message when a create is refused', async () => {
    client.post.mockRejectedValue(new Error('A person with this email already exists'));
    const res = await api.createPerson({ firstName: 'Jane', email: 'jane@acme.com' });
    expect(res).toEqual({ success: false, error: 'A person with this email already exists' });
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
    expect(res.data).toMatchObject({ id: 'opp_1', companyId: 'cmp_1', value: '5000', currency: 'GBP', status: 'open' });
  });

  it('leaves the close date out when none was given', async () => {
    client.post.mockResolvedValue({ data: { id: 'opp_2' } });
    await api.createDeal({ name: 'No date', companyId: 'cmp_1' });
    expect(client.post.mock.calls[0][1].closeDate).toBeUndefined();
  });

  it('moves a deal by writing both stage columns, then reads it back', async () => {
    client.patch.mockResolvedValue({ data: { id: 'opp_1' } });
    client.get.mockResolvedValue({
      data: { id: 'opp_1', name: 'Q4', stageId: 'stg_won', status: 'won', createdAt: 'x', updatedAt: 'x' },
    });
    const res = await api.updateDeal('opp_1', { stageId: 'stg_won' });
    expect(client.patch).toHaveBeenCalledWith('/opportunities/opp_1', { stageId: 'stg_won', stage: 'stg_won' });
    expect(res.data).toMatchObject({ stageId: 'stg_won', status: 'won' });
  });

  it('clears a close date with null', () => {
    expect(dealUpdatePayload({ closeDate: null, status: 'lost' })).toEqual({ closeDate: null, status: 'lost' });
  });

  it('reads stages per pipeline', async () => {
    client.get.mockImplementation((path: string) => {
      if (path.startsWith('/pipelines')) return Promise.resolve(list([{ id: 'pl_1', name: 'Sales' }]));
      if (path === '/pipeline-stages?pipeline=pl_1&limit=200') {
        return Promise.resolve(
          list([
            { id: 'st_2', name: 'Won', position: 1, pipeline: 'pl_1', isWon: true },
            { id: 'st_1', name: 'Lead', position: 0, pipeline: 'pl_1' },
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const res = await api.getPipelines();
    expect(res.data?.[0].stages.map((stage) => [stage.name, stage.isWon])).toEqual([
      ['Lead', false],
      ['Won', true],
    ]);
  });

  it('logs an activity as completed and links the company', async () => {
    client.post.mockResolvedValue({ data: { id: 'act_2' } });
    await api.logActivity({ type: 'call', subject: ' Intro ', record: { kind: 'company', id: 'cmp_1', name: 'Acme' } });
    expect(client.post).toHaveBeenCalledWith(
      '/activities',
      expect.objectContaining({
        type: 'call',
        subject: 'Intro',
        status: 'completed',
        customerId: 'cmp_1',
        relatedTo: 'company',
        relatedToId: 'cmp_1',
        relatedToName: 'Acme',
      }),
    );
  });

  it('links a person activity through contactId, like the web', async () => {
    client.post.mockResolvedValue({ data: { id: 'act_3' } });
    await api.logActivity({ type: 'note', subject: 'Hi', record: { kind: 'person', id: 'per_1' } });
    const body = client.post.mock.calls[0][1];
    expect(body).toMatchObject({ contactId: 'per_1', relatedTo: 'person', relatedToId: 'per_1' });
    expect(body.customerId).toBeUndefined();
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
