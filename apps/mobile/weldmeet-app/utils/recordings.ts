/**
 * Pure helpers for the recordings list: what a recording's state means for the
 * UI, and how to turn an access-URL failure into something a person can read.
 *
 * Recordings are private. `GET /meetings/recordings` returns state only
 * (`recordingUrl` is always null), so a playable URL is minted on demand with
 * `POST /meeting-sessions/:id/recording/access` and never stored.
 */

import type { RecordingSummary } from '@weldsuite/core-api-client/schemas/weldmeet';

export type RecordingStatus = NonNullable<RecordingSummary['recordingStatus']>;

export interface RecordingStateInfo {
  /** True only when a tap may fetch an access URL. */
  playable: boolean;
  /** Short line shown under the title; null when the recording is ready. */
  label: string | null;
}

const STATUS_LABELS: Record<Exclude<RecordingStatus, 'ready'>, string> = {
  recording: 'Recording in progress',
  processing: 'Recording still processing',
  failed: 'Recording failed',
  unavailable: 'Recording no longer available',
  deleted: 'Recording deleted',
};

/** Legacy rows (status null) predate the recorder and have no private file to mint a URL for. */
const LEGACY_LABEL = 'Recording not available';

export function getRecordingStateInfo(
  recording: Pick<RecordingSummary, 'recordingStatus'>,
): RecordingStateInfo {
  const status = recording.recordingStatus;
  if (status === 'ready') return { playable: true, label: null };
  if (status == null) return { playable: false, label: LEGACY_LABEL };
  return { playable: false, label: STATUS_LABELS[status] ?? LEGACY_LABEL };
}

/** Seconds of recorded media, preferring the recorder's own figure over the session duration. */
export function getRecordingDurationSeconds(
  recording: Pick<RecordingSummary, 'recordingDurationSeconds' | 'duration'>,
): number | null {
  return recording.recordingDurationSeconds ?? recording.duration ?? null;
}

/** Reads the HTTP status off an `ApiError` without importing the transport. */
function statusOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * Message for a failed recording action (open now; transcribe if it is ever
 * added). 402 = not enough credits, 403 = missing permission, 404 = nothing to
 * open, 409 = still being processed. Anything else falls back to the server
 * message, then the caller's default.
 */
export function describeRecordingError(err: unknown, fallback: string): string {
  switch (statusOf(err)) {
    case 402:
      return 'Not enough credits for this action.';
    case 403:
      return 'You do not have permission to do this.';
    case 404:
      return 'This recording is no longer available.';
    case 409:
      return err instanceof Error && err.message
        ? err.message
        : 'The recording is still being processed. Try again in a few minutes.';
    default:
      break;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
