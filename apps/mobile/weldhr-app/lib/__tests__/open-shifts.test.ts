import { canSignUp, listableOpenShifts, standingOf, type Posted } from '../open-shifts';

/** Wednesday 18 March 2026 at `hh:mm` (and `dayOfMonth`), local time, as the API sends it. */
const at = (hhmm: string, dayOfMonth = 18) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 2, dayOfMonth, h, m).toISOString();
};
const now = new Date(at('12:00')).getTime();

const shift = (id: string, start: string, extra: Partial<Posted> = {}): Posted => ({
  id,
  startsAt: at(start, 20),
  endsAt: at('17:00', 20),
  spotsLeft: 2,
  myRequest: null,
  ...extra,
});
const request = (status: 'pending' | 'approved' | 'rejected' | 'cancelled', reviewNote: string | null = null) => ({
  id: 'req_1',
  status,
  reviewNote,
});

describe('standingOf', () => {
  it('is open while there is a spot and I have not signed up', () => {
    expect(standingOf(shift('a', '09:00'))).toBe('open');
  });

  it('is waiting while my sign-up is pending, and declined once turned down', () => {
    expect(standingOf(shift('a', '09:00', { myRequest: request('pending') }))).toBe('waiting');
    expect(standingOf(shift('a', '09:00', { myRequest: request('rejected', 'Filled') }))).toBe('declined');
  });

  it('is full without spots, and treats a withdrawn sign-up as none', () => {
    expect(standingOf(shift('a', '09:00', { spotsLeft: 0 }))).toBe('full');
    expect(standingOf(shift('a', '09:00', { myRequest: request('cancelled') }))).toBe('open');
  });
});

describe('canSignUp', () => {
  it('needs a spot, a shift still to come and no sign-up waiting', () => {
    expect(canSignUp(shift('a', '09:00'), now)).toBe(true);
    expect(canSignUp(shift('a', '09:00', { spotsLeft: 0 }), now)).toBe(false);
    expect(canSignUp(shift('a', '09:00', { myRequest: request('pending') }), now)).toBe(false);
    expect(canSignUp({ ...shift('a', '09:00'), startsAt: at('09:00', 17) }, now)).toBe(false);
  });

  it('lets me try again after a declined or withdrawn sign-up when a spot is left', () => {
    expect(canSignUp(shift('a', '09:00', { myRequest: request('rejected') }), now)).toBe(true);
    expect(canSignUp(shift('a', '09:00', { myRequest: request('cancelled') }), now)).toBe(true);
  });
});

describe('listableOpenShifts', () => {
  it('lists upcoming shifts soonest first', () => {
    const list = [shift('late', '14:00'), shift('early', '07:00'), { ...shift('today', '12:30'), startsAt: at('12:30', 18) }];
    expect(listableOpenShifts(list, now).map((s) => s.id)).toEqual(['today', 'early', 'late']);
  });

  it('leaves out shifts that started, that I got, and full ones I have no answer in', () => {
    const list = [
      { ...shift('started', '09:00'), startsAt: at('09:00', 18) },
      shift('got', '09:00', { myRequest: request('approved') }),
      shift('full', '09:00', { spotsLeft: 0 }),
      shift('full-withdrawn', '09:00', { spotsLeft: 0, myRequest: request('cancelled') }),
      shift('open', '10:00'),
    ];
    expect(listableOpenShifts(list, now).map((s) => s.id)).toEqual(['open']);
  });

  it('keeps a full shift my sign-up is waiting in, or was declined for', () => {
    const list = [
      shift('waiting', '09:00', { spotsLeft: 0, myRequest: request('pending') }),
      shift('declined', '10:00', { spotsLeft: 0, myRequest: request('rejected', 'Someone else got it') }),
    ];
    expect(listableOpenShifts(list, now).map((s) => s.id)).toEqual(['waiting', 'declined']);
  });
});
