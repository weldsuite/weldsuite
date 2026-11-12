/**
 * The report requests of the WeldDesk domain client: the export URLs and the
 * schedule calls, with their responses checked against the shared Zod schemas.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  getRaw: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../app-api-browser-client', () => ({ appApi: api }));

import { helpdeskWorkerApi } from './welddesk';

const scheduleRow = {
  id: 'sched_1',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
  name: 'Weekly',
  reportId: null,
  reportTitle: null,
  range: 'last_7_days',
  frequency: 'weekly',
  dayOfWeek: 1,
  dayOfMonth: null,
  hour: 8,
  timezone: 'Europe/Amsterdam',
  recipients: ['a@example.com'],
  attachCsv: true,
  locale: 'en',
  enabled: true,
  createdById: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('CSV export requests', () => {
  it('fetches the overview export of a range', async () => {
    api.getRaw.mockResolvedValue(new Response(''));
    await helpdeskWorkerApi.exportOverviewCsv('last_90_days');
    expect(api.getRaw).toHaveBeenCalledWith('/helpdesk-analytics/overview/export?range=last_90_days');
  });

  it('fetches the export of a saved report', async () => {
    api.getRaw.mockResolvedValue(new Response(''));
    await helpdeskWorkerApi.exportReportCsv('rpt_1');
    expect(api.getRaw).toHaveBeenCalledWith('/helpdesk-analytics/reports/rpt_1/export');
  });
});

describe('schedule requests', () => {
  it('lists, creates and updates through the schedule routes', async () => {
    api.get.mockResolvedValue({ data: [scheduleRow] });
    expect(await helpdeskWorkerApi.listReportSchedules()).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/helpdesk-analytics/schedules');

    api.post.mockResolvedValue({ data: scheduleRow });
    await helpdeskWorkerApi.createReportSchedule({
      name: 'Weekly',
      frequency: 'weekly',
      dayOfWeek: 1,
      hour: 8,
      timezone: 'Europe/Amsterdam',
      recipients: ['A@example.com'],
    });
    expect(api.post).toHaveBeenCalledWith(
      '/helpdesk-analytics/schedules',
      expect.objectContaining({ recipients: ['a@example.com'] }),
    );

    api.patch.mockResolvedValue({ data: scheduleRow });
    await helpdeskWorkerApi.updateReportSchedule('sched_1', { enabled: false });
    expect(api.patch).toHaveBeenCalledWith('/helpdesk-analytics/schedules/sched_1', { enabled: false });
  });

  it('refuses a weekly schedule without a day before it is sent', async () => {
    await expect(
      helpdeskWorkerApi.createReportSchedule({
        name: 'Weekly',
        frequency: 'weekly',
        hour: 8,
        timezone: 'UTC',
        recipients: ['a@example.com'],
      }),
    ).rejects.toThrow();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('deletes and sends now', async () => {
    api.delete.mockResolvedValue(undefined);
    await helpdeskWorkerApi.deleteReportSchedule('sched_1');
    expect(api.delete).toHaveBeenCalledWith('/helpdesk-analytics/schedules/sched_1');

    api.post.mockResolvedValue({ data: { status: 'failed', error: 'Mailbox is full' } });
    expect(await helpdeskWorkerApi.sendReportSchedule('sched_1')).toEqual({ status: 'failed', error: 'Mailbox is full' });
    expect(api.post).toHaveBeenLastCalledWith('/helpdesk-analytics/schedules/sched_1/send');
  });
});
