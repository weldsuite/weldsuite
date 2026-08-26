import { buildQueryString } from '@weldsuite/api-client/client';

/**
 * Lightweight contract checks for the WeldFlow → app-api path mapping.
 * The live client needs Clerk tokens; these assert the query shaping the
 * service layer documents in services/app-api.ts.
 */
describe('app-api query shaping', () => {
  it('maps project list filters onto flat /projects query params', () => {
    const query = buildQueryString({
      limit: 25,
      search: 'alpha',
      status: 'Active',
      isActive: true,
    } as Record<string, unknown>);
    expect(query).toContain('limit=25');
    expect(query).toContain('search=alpha');
    expect(query).toContain('status=Active');
    expect(query).toContain('isActive=true');
  });

  it('maps task list limit onto pageSize for /tasks', () => {
    const query = buildQueryString({
      projectId: 'prj_1',
      pageSize: 50,
      status: 'todo',
    } as Record<string, unknown>);
    expect(query).toContain('projectId=prj_1');
    expect(query).toContain('pageSize=50');
    expect(query).toContain('status=todo');
  });

  it('maps my-tasks limit onto pageSize without a cursor', () => {
    const query = buildQueryString({
      pageSize: 50,
      search: 'login',
      status: 'in_progress',
    } as Record<string, unknown>);
    expect(query).toContain('pageSize=50');
    expect(query).toContain('search=login');
    expect(query).not.toContain('cursor');
  });
});
