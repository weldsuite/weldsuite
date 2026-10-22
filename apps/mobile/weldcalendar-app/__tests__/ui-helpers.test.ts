import { accountLines } from '@/lib/account';
import { BRAND } from '@/lib/brand';
import { calendarGroupLabel } from '@/lib/calendar-access';
import { isTaskEvent, visibleEventStatus } from '@/lib/event-source';
import { switchColors } from '@/lib/switch-colors';
import type { Calendar } from '@/types/weldcalendar';

function calendar(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'cal_1',
    name: 'My Calendar',
    description: null,
    color: null,
    ownerId: 'user_me',
    isDefault: true,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isOwn: true,
    permission: 'manage',
    ...overrides,
  };
}

describe('calendarGroupLabel', () => {
  it('tells two calendars with the same name apart', () => {
    const personal = calendar({ tenantKind: 'personal' });
    const workspace = calendar({ tenantKind: 'workspace', workspaceName: 'Acme' });
    expect(calendarGroupLabel(personal, 'Personal')).toBe('Personal');
    expect(calendarGroupLabel(workspace, 'Personal')).toBe('Acme');
  });

  it('is null when the workspace is unknown', () => {
    expect(calendarGroupLabel(calendar({ workspaceName: null }), 'Personal')).toBeNull();
  });
});

describe('task events', () => {
  it('recognises an event placed from a task', () => {
    expect(isTaskEvent({ sourceType: 'task' })).toBe(true);
    expect(isTaskEvent({ sourceType: 'activity' })).toBe(false);
    expect(isTaskEvent({ sourceType: null })).toBe(false);
  });

  it('hides "Confirmed" on a task block but keeps every other state', () => {
    expect(visibleEventStatus({ sourceType: 'task', status: 'confirmed' })).toBeNull();
    expect(visibleEventStatus({ sourceType: 'task', status: 'cancelled' })).toBe('cancelled');
    expect(visibleEventStatus({ sourceType: null, status: 'confirmed' })).toBe('confirmed');
    expect(visibleEventStatus({ sourceType: 'activity', status: 'tentative' })).toBe('tentative');
  });
});

describe('switchColors', () => {
  const theme = { border: '#E5E5EA', muted: '#8E8E93' };

  it('colours the track and the knob in both states', () => {
    const on = switchColors(theme, true);
    const off = switchColors(theme, false);
    expect(on.trackColor).toEqual({ false: theme.border, true: BRAND });
    expect(on.thumbColor).toBe('#FFFFFF');
    expect(off.thumbColor).toBe(theme.muted);
    expect(off.ios_backgroundColor).toBe(theme.border);
  });
});

describe('accountLines', () => {
  it('shows the name, then the email and workspace', () => {
    expect(
      accountLines({ fullName: 'Ada', email: 'ada@x.io', workspaceName: 'Acme' }, '—'),
    ).toEqual({ title: 'Ada', subtitle: 'ada@x.io · Acme' });
  });

  it('does not repeat the email when there is no name', () => {
    expect(
      accountLines({ fullName: '', email: 'ada@x.io', workspaceName: 'Acme' }, '—'),
    ).toEqual({ title: 'ada@x.io', subtitle: 'Acme' });
    expect(accountLines({ fullName: null, email: 'ada@x.io' }, '—')).toEqual({
      title: 'ada@x.io',
      subtitle: '',
    });
  });

  it('falls back when nothing is known', () => {
    expect(accountLines({}, '—')).toEqual({ title: '—', subtitle: '' });
  });
});
