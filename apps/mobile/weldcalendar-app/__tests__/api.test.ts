import { buildQueryString } from '@weldsuite/api-client/client';

/**
 * Lightweight contract checks for the WeldCalendar → app-api path mapping.
 * The live client needs Clerk tokens; these assert the query shaping the
 * service layer documents in services/app-api.ts.
 */
describe('app-api query shaping', () => {
  it('sends a range window as ISO startDate/endDate', () => {
    const query = buildQueryString({
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.999Z',
    } as Record<string, unknown>);
    expect(query).toContain('startDate=2026-03-01T00%3A00%3A00.000Z');
    expect(query).toContain('endDate=2026-03-31T23%3A59%3A59.999Z');
  });

  it('passes calendarIds through as a comma-separated list', () => {
    const query = buildQueryString({
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-02T00:00:00.000Z',
      calendarIds: 'cal_1,cal_2',
    } as Record<string, unknown>);
    expect(query).toContain('calendarIds=cal_1%2Ccal_2');
  });

  it('drops an undefined calendarIds so the route falls back to every readable calendar', () => {
    const query = buildQueryString({
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-02T00:00:00.000Z',
      calendarIds: undefined,
    } as Record<string, unknown>);
    expect(query).not.toContain('calendarIds');
  });

  it('shapes the cursor-paginated event list', () => {
    const query = buildQueryString({
      limit: 50,
      search: 'standup',
      type: 'meeting',
      status: 'confirmed',
    } as Record<string, unknown>);
    expect(query).toContain('limit=50');
    expect(query).toContain('search=standup');
    expect(query).toContain('type=meeting');
    expect(query).toContain('status=confirmed');
  });
});
