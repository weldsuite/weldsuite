import type { CloudflareRealtimeEnv } from '@weldsuite/cloudflare-realtime';
import type { EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import type { CopyMeetingRecordingParams } from './workflows/copy-meeting-recording';

/**
 * Bindings the meet-domain workflows and helpers read. meet-api's `Env`
 * satisfies it; nothing here is specific to one worker.
 *
 * AI: `@weldsuite/ai` resolves its own config from the same bag (`CF_ACCOUNT_ID`
 * plus `AI_GATEWAY_API_TOKEN` or `CLOUDFLARE_API_TOKEN`, optional
 * `CF_AI_GATEWAY`), so those are not repeated here.
 */
export type MeetDomainEnv = DbEnv &
  CloudflareRealtimeEnv &
  EntityEventPublisherEnv & {
    /** Private R2 bucket for recordings, transcripts and summaries. Never publicly served. */
    MEETING_RECORDINGS?: R2Bucket;
    /** Copy workflow, used by the legacy backfill to queue copies. */
    MEETING_RECORDING_COPY?: Workflow<CopyMeetingRecordingParams>;
  };

export function recordingsBucket(env: MeetDomainEnv): R2Bucket {
  if (!env.MEETING_RECORDINGS) throw new Error('MEETING_RECORDINGS bucket is not bound');
  return env.MEETING_RECORDINGS;
}
