import {
  clockedOutGaps,
  earnings,
  minutesBetween,
  minutesOf,
  plannedBreak,
  plannedMinutes,
  shiftOf,
  type Clocked,
} from '../shifts';

/** Wednesday 18 March 2026 at `hh:mm`, local time, as the API sends it. */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 2, 18, h, m).toISOString();
};
const day = '2026-03-18';

const morning = { id: 'sh_morning', startsAt: at('08:00'), endsAt: at('12:00') };
const afternoon = {
  id: 'sh_afternoon',
  startsAt: at('13:00'),
  endsAt: at('17:30'),
  breakStartsAt: at('15:00'),
  breakEndsAt: at('15:30'),
};

const record = (clockIn: string, clockOut: string | null, extra: Partial<Clocked> = {}): Clocked => ({
  date: day,
  clockIn: at(clockIn),
  clockOut: clockOut ? at(clockOut) : null,
  workedMinutes: clockOut ? minutesBetween(at(clockIn), at(clockOut)) : null,
  ...extra,
});

describe('planned hours', () => {
  it('leaves the unpaid break out of a shift', () => {
    expect(plannedMinutes(morning)).toBe(240);
    expect(plannedMinutes(afternoon)).toBe(240);
    expect(plannedBreak(morning)).toBeNull();
    expect(plannedBreak(afternoon)).toEqual({ start: at('15:00'), end: at('15:30') });
  });
});

describe('shiftOf', () => {
  const shifts = [morning, afternoon];

  it('takes the shift a record is linked to', () => {
    expect(shiftOf(record('07:00', '07:30', { shiftId: 'sh_afternoon' }), shifts, 0)?.id).toBe('sh_afternoon');
  });

  it('falls back to the shift that day the hours overlap', () => {
    expect(shiftOf(record('07:55', '12:02'), shifts, 0)?.id).toBe('sh_morning');
    expect(shiftOf(record('12:58', '17:31'), shifts, 0)?.id).toBe('sh_afternoon');
  });

  it('counts a running record up to now', () => {
    const now = new Date(at('13:20')).getTime();
    expect(shiftOf(record('12:50', null), shifts, now)?.id).toBe('sh_afternoon');
  });

  it('finds none for hours outside every shift', () => {
    expect(shiftOf(record('18:00', '20:00'), shifts, 0)).toBeUndefined();
  });
});

describe('breaks and pay', () => {
  it('turns clocking out and back in into a break, not a slip of under a minute', () => {
    // Clocked out at 12:00 and straight back in 20 seconds later.
    const backIn = new Date(new Date(at('12:00')).getTime() + 20_000).toISOString();
    const stretches = [
      record('13:05', '17:31'),
      record('08:00', '10:15'),
      record('10:45', '12:00'),
      { ...record('12:00', '12:30'), clockIn: backIn },
    ];
    expect(clockedOutGaps(stretches)).toEqual([
      { start: at('10:15'), end: at('10:45') },
      { start: at('12:30'), end: at('13:05') },
    ]);
  });

  it('counts a running record so far', () => {
    const now = new Date(at('10:30')).getTime();
    expect(minutesOf(record('09:00', null), now)).toBe(90);
  });

  it('earns at each record’s own rate, and € 0,00 without one', () => {
    const paid = [
      { ...record('09:00', '11:00'), hourlyRate: 18, currency: 'EUR' },
      { ...record('13:00', '13:30'), hourlyRate: 20, currency: 'EUR' },
    ];
    // 2 hours at 18 and half an hour at 20.
    expect(earnings(paid, 0, 'EUR', 'nl-NL')).toMatch(/46,00/);
    expect(earnings([record('09:00', '11:00')], 0, 'EUR', 'nl-NL')).toMatch(/0,00/);
  });
});
