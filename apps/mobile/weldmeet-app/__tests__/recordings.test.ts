import {
  describeRecordingError,
  getRecordingDurationSeconds,
  getRecordingStateInfo,
} from '../utils/recordings';

type Status = Parameters<typeof getRecordingStateInfo>[0]['recordingStatus'];

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe('getRecordingStateInfo', () => {
  it('is playable only when the recording is ready', () => {
    expect(getRecordingStateInfo({ recordingStatus: 'ready' })).toEqual({
      playable: true,
      label: null,
    });
  });

  it.each<[Status, string]>([
    ['recording', 'Recording in progress'],
    ['processing', 'Recording still processing'],
    ['failed', 'Recording failed'],
    ['unavailable', 'Recording no longer available'],
    ['deleted', 'Recording deleted'],
  ])('does not allow playback while %s', (status, label) => {
    expect(getRecordingStateInfo({ recordingStatus: status })).toEqual({ playable: false, label });
  });

  it('treats legacy rows (null or missing status) as not playable', () => {
    expect(getRecordingStateInfo({ recordingStatus: null }).playable).toBe(false);
    expect(getRecordingStateInfo({}).playable).toBe(false);
  });
});

describe('getRecordingDurationSeconds', () => {
  it('prefers the recorder duration, then the session duration', () => {
    expect(getRecordingDurationSeconds({ recordingDurationSeconds: 90, duration: 120 })).toBe(90);
    expect(getRecordingDurationSeconds({ recordingDurationSeconds: null, duration: 120 })).toBe(120);
    expect(getRecordingDurationSeconds({})).toBeNull();
  });
});

describe('describeRecordingError', () => {
  it('maps 402 to an insufficient-credits message', () => {
    expect(describeRecordingError(new FakeApiError('Insufficient credits', 402), 'x')).toBe(
      'Not enough credits for this action.',
    );
  });

  it('maps 403 to a permission message', () => {
    expect(describeRecordingError(new FakeApiError('Forbidden', 403), 'x')).toBe(
      'You do not have permission to do this.',
    );
  });

  it('maps 404 to unavailable', () => {
    expect(describeRecordingError(new FakeApiError('Not found', 404), 'x')).toBe(
      'This recording is no longer available.',
    );
  });

  it('keeps the server message for 409 (still processing / failed)', () => {
    expect(describeRecordingError(new FakeApiError('The recording failed.', 409), 'x')).toBe(
      'The recording failed.',
    );
  });

  it('falls back to the error message, then the default', () => {
    expect(describeRecordingError(new Error('boom'), 'x')).toBe('boom');
    expect(describeRecordingError('weird', 'Could not open the recording')).toBe(
      'Could not open the recording',
    );
  });
});
