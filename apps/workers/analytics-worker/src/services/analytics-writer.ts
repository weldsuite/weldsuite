import type { Env } from '../env';
import type { AnalyticsRecord } from './event-processor';

/**
 * Send an analytics record to the Cloudflare Pipeline stream.
 */
export async function writeAnalyticsRecord(env: Env, record: AnalyticsRecord): Promise<void> {
  await env.ANALYTICS_STREAM.send([record]);
}
