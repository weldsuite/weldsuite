import { describe, expect, it } from 'vitest';
import { forecastPhase, placeSprintsInPhases, sprintsOfCapacityLeft } from './phase-sprints';

const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

const phases = [
  { id: 'design', plannedStart: '2026-09-01', plannedEnd: '2026-10-26' },
  { id: 'build', plannedStart: '2026-10-27', plannedEnd: '2027-01-16' },
  { id: 'open', plannedStart: null, plannedEnd: null },
];

const sprint = (id: string, startDate: string | null, endDate: string | null = null) => ({ id, startDate, endDate });

describe('placeSprintsInPhases', () => {
  it('puts a sprint in the phase that holds its start date', () => {
    const { byPhase, unplaced } = placeSprintsInPhases(phases, [
      sprint('s1', '2026-10-27'),
      sprint('s2', '2026-11-10'),
      sprint('s0', '2026-10-20'),
    ]);
    expect(byPhase.get('build')?.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(byPhase.get('design')?.map((s) => s.id)).toEqual(['s0']);
    expect(unplaced).toEqual([]);
  });

  it('keeps sprints outside every phase or without dates unplaced', () => {
    const { byPhase, unplaced } = placeSprintsInPhases(phases, [sprint('late', '2027-03-01'), sprint('none', null)]);
    expect(unplaced.map((s) => s.id)).toEqual(['late', 'none']);
    expect(byPhase.get('build')).toEqual([]);
  });

  it('falls back to the end date, and counts the first and last day of a phase', () => {
    const { byPhase } = placeSprintsInPhases(phases, [sprint('a', null, '2026-12-01'), sprint('b', '2027-01-16')]);
    expect(byPhase.get('build')?.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('forecastPhase', () => {
  const base = { sprintLengthDays: 14, today: day('2026-11-24'), phaseEnd: '2027-01-16' };

  it('counts the running sprint as the first one left', () => {
    const forecast = forecastPhase({ ...base, openPoints: 58, velocity: 21, activeSprintEnd: '2026-12-01' });
    expect(forecast.sprintsLeft).toBe(3);
    expect(forecast.finishDay).toBe(day('2026-12-29'));
    expect(forecast.state).toBe('onPlan');
  });

  it('starts today without a running sprint', () => {
    const forecast = forecastPhase({ ...base, openPoints: 20, velocity: 21, activeSprintEnd: null });
    expect(forecast.sprintsLeft).toBe(1);
    expect(forecast.finishDay).toBe(day('2026-12-08'));
  });

  it('is late past the planned end, in whole sprints', () => {
    const forecast = forecastPhase({ ...base, openPoints: 150, velocity: 21, activeSprintEnd: '2026-12-01' });
    expect(forecast.sprintsLeft).toBe(8);
    expect(forecast.state).toBe('late');
    expect(forecast.lateBySprints).toBe(forecastLate(forecast.finishDay, '2027-01-16'));
  });

  it('is done without open points and unknown without velocity', () => {
    expect(forecastPhase({ ...base, openPoints: 0, velocity: null, activeSprintEnd: null }).state).toBe('done');
    expect(forecastPhase({ ...base, openPoints: 10, velocity: null, activeSprintEnd: null }).state).toBe('unknown');
    expect(forecastPhase({ ...base, openPoints: 10, velocity: 0, activeSprintEnd: null }).finishDay).toBeNull();
  });

  it('is on plan when the phase has no end date', () => {
    expect(forecastPhase({ ...base, phaseEnd: null, openPoints: 100, velocity: 10, activeSprintEnd: null }).state).toBe('onPlan');
  });
});

function forecastLate(finishDay: number | null, end: string): number {
  return Math.ceil(((finishDay ?? 0) - day(end)) / 14);
}

describe('sprintsOfCapacityLeft', () => {
  it('counts the sprints that fit before the phase ends', () => {
    expect(
      sprintsOfCapacityLeft({ sprintLengthDays: 14, today: day('2026-11-24'), activeSprintEnd: '2026-12-01', phaseEnd: '2027-01-16' }),
    ).toBe(4);
  });

  it('is zero past the end and null without an end', () => {
    expect(sprintsOfCapacityLeft({ sprintLengthDays: 14, today: day('2027-02-01'), activeSprintEnd: null, phaseEnd: '2027-01-16' })).toBe(0);
    expect(sprintsOfCapacityLeft({ sprintLengthDays: 14, activeSprintEnd: null, phaseEnd: null })).toBeNull();
  });
});
