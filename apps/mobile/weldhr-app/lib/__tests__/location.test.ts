import { locateForClock, toClockLocation, type Fix, type LocationSource } from '../location';

const fix = (latitude: number, longitude: number, accuracy: number | null = 12.4): Fix => ({
  coords: { latitude, longitude, accuracy },
});

/** A source that grants permission and answers as given; each answer may be a value, a rejection or never. */
function source(parts: Partial<LocationSource> = {}): LocationSource {
  return {
    requestPermission: () => Promise.resolve({ granted: true }),
    currentPosition: () => Promise.resolve(fix(52.37, 4.9)),
    lastKnownPosition: () => Promise.resolve(null),
    ...parts,
  };
}

describe('toClockLocation', () => {
  it('rounds the accuracy to metres', () => {
    expect(toClockLocation(fix(52.37, 4.9, 12.6))).toEqual({ latitude: 52.37, longitude: 4.9, accuracy: 13 });
  });

  it('leaves the accuracy out when the device does not say', () => {
    expect(toClockLocation(fix(52.37, 4.9, null))).toEqual({ latitude: 52.37, longitude: 4.9 });
  });

  it('refuses a position that is not a number', () => {
    expect(toClockLocation(fix(Number.NaN, 4.9))).toBeNull();
  });
});

describe('locateForClock', () => {
  afterEach(() => jest.useRealTimers());

  it('sends the fresh position', async () => {
    await expect(locateForClock(source())).resolves.toEqual({
      status: 'ok',
      location: { latitude: 52.37, longitude: 4.9, accuracy: 12 },
    });
  });

  it('stops at a refused permission without asking for a position', async () => {
    const currentPosition = jest.fn();
    const result = await locateForClock(source({ requestPermission: () => Promise.resolve({ granted: false }), currentPosition }));
    expect(result).toEqual({ status: 'denied' });
    expect(currentPosition).not.toHaveBeenCalled();
  });

  it('counts a permission request that throws as refused', async () => {
    const result = await locateForClock(source({ requestPermission: () => Promise.reject(new Error('no')) }));
    expect(result).toEqual({ status: 'denied' });
  });

  it('falls back to the last known position when the fresh one fails', async () => {
    const result = await locateForClock(
      source({
        currentPosition: () => Promise.reject(new Error('location services off')),
        lastKnownPosition: () => Promise.resolve(fix(51.9, 5.1, 30)),
      }),
    );
    expect(result).toEqual({ status: 'ok', location: { latitude: 51.9, longitude: 5.1, accuracy: 30 } });
  });

  it('falls back to the last known position when the fresh one takes too long', async () => {
    jest.useFakeTimers();
    const pending = locateForClock(
      source({
        currentPosition: () => new Promise<Fix>(() => {}),
        lastKnownPosition: () => Promise.resolve(fix(51.9, 5.1, 30)),
      }),
      5000,
    );
    await jest.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ status: 'ok', location: { latitude: 51.9, longitude: 5.1, accuracy: 30 } });
  });

  it('is unavailable when there is no fresh and no last known position', async () => {
    const result = await locateForClock(source({ currentPosition: () => Promise.reject(new Error('no signal')) }));
    expect(result).toEqual({ status: 'unavailable' });
  });
});
