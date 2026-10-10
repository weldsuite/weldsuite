/**
 * "One live call at a time" across WeldChat and WeldMeet.
 *
 * After a user SUCCESSFULLY joins a chat call, the server drops them from every
 * other chat call and every meeting session they are still in, across tabs and
 * devices. The browser tab asks the user first; this only enforces. Always a
 * leave, never an end for everyone (see `@weldsuite/chat-domain/call-participants`
 * and `@weldsuite/meet-domain/leave-other-sessions`).
 *
 * Run it from `c.executionCtx.waitUntil` AFTER the join has been written, so a
 * failed join never drops the user's current call. Logs and swallows its own
 * errors. `triggeredAt` is when the joining request started: a participation that
 * began after it is a newer join elsewhere and is left alone.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import { leaveOtherActiveCalls } from '@weldsuite/chat-domain/call-participants';
import { leaveOtherMeetingSessions } from '@weldsuite/meet-domain/leave-other-sessions';
import type { Env } from '../../types';

export async function leaveOtherLiveCalls(
  db: Database,
  env: Env,
  orgId: string,
  userId: string,
  exceptCallId: string,
  triggeredAt: number,
): Promise<void> {
  await Promise.all([
    leaveOtherActiveCalls(db, env, orgId, userId, exceptCallId, { triggeredAt }),
    // The joined call is a chat call, so no meeting session is spared.
    leaveOtherMeetingSessions(db, env, orgId, userId, null, { triggeredAt }),
  ]);
}
