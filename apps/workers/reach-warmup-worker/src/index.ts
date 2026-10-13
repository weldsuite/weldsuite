/**
 * WeldSuite reach-warmup-worker — the WeldReach warmup network.
 *
 * docs/plans/weldreach-warmup.md. Crons plan and dispatch work; two queues
 * carry it out (SMTP sends, IMAP engagements). Master DB only.
 */

import type { Env, WarmupEngageMessage, WarmupSendMessage } from './env';
import { runDispatch } from './dispatch';
import { runPlanner } from './planner';
import { runDaily } from './daily';
import { handleSendBatch } from './send';
import { handleEngageBatch } from './engage';

export const DISPATCH_CRON = '* * * * *';
export const PLANNER_CRON = '*/30 * * * *';
export const DAILY_CRON = '30 2 * * *';

type WarmupBatch = MessageBatch<WarmupSendMessage> | MessageBatch<WarmupEngageMessage>;

export default {
  async fetch(): Promise<Response> {
    return new Response('reach-warmup-worker', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const task =
      event.cron === PLANNER_CRON ? runPlanner(env) : event.cron === DAILY_CRON ? runDaily(env) : runDispatch(env);
    ctx.waitUntil(
      task.catch((err) => {
        console.error(`[reach-warmup] cron ${event.cron} failed:`, err);
      }),
    );
  },

  async queue(batch: WarmupBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue.startsWith('reach-warmup-engage')) {
      await handleEngageBatch(batch as MessageBatch<WarmupEngageMessage>, env, ctx);
      return;
    }
    await handleSendBatch(batch as MessageBatch<WarmupSendMessage>, env, ctx);
  },
};
