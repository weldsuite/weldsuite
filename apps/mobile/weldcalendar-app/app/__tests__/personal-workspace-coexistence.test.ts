import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Personal calendars used to be unreachable once a Clerk org was active.
 * These source guards lock the product decision: workspace membership
 * no longer excludes personal-api, and the agenda merges both tenants.
 */
describe('Personal + workspace coexistence', () => {
  const layout = readFileSync(join(__dirname, '../_layout.tsx'), 'utf8');
  const calendarTenant = readFileSync(
    join(__dirname, '../../services/calendar-tenant.ts'),
    'utf8',
  );
  const hooks = readFileSync(join(__dirname, '../../hooks/use-weldcalendar.ts'), 'utf8');

  it('AuthGuard does not treat org membership as excluding personal calendars', () => {
    expect(layout).toMatch(/Personal calendars are loaded alongside workspace/);
    expect(layout).toMatch(/personalApi\.onboard/);
    expect(layout).toMatch(/setPersonalApiTokenGetter/);
  });

  it('calendar-tenant routes list/range/CRUD by tenantKind', () => {
    expect(calendarTenant).toMatch(/TenantKind = 'workspace' \| 'personal'/);
    expect(calendarTenant).toMatch(/personalApi\.calendars/);
    expect(calendarTenant).toMatch(/appApi\.weldcalendar/);
    expect(calendarTenant).toMatch(/listMergedEventsInRange/);
  });

  it('hooks fetch a merged personal + workspace calendar list', () => {
    expect(hooks).toMatch(/listMergedCalendars/);
    expect(hooks).toMatch(/listMergedEventsInRange/);
  });
});
