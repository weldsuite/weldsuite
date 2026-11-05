/**
 * Monthly measuring of benefits — Cloudflare cron handler (FLOW-014).
 *
 * Every open benefit with a catalogue metric (`planned`, `measuring` or
 * `at_risk`, on any project, an archived one included) gets the value of the
 * month that just ended, upserted into `project_benefit_measurements`. A
 * benefit that is realised or closed stops being measured; a `manual` benefit
 * is never measured here (its owner gets a monthly check-in on the digest).
 *
 * Scheduling follows ADR DATA-008 (nothing opens tenant databases on a timer),
 * like the file purge: the routes that create or edit a benefit mark their
 * workspace due at the next month boundary (`kind: benefit_measure`, see
 * lib/benefit-measure.ts). The daily sweep (see `[triggers]` in wrangler.toml)
 * reads only that index, opens just the due workspaces, measures their
 * benefits and stores when the workspace is next due: the first day of the
 * next month while any open benefit with a metric remains, else the row is
 * dropped. There is nothing to seed: the table did not exist before the index.
 */

import { and, inArray, isNull, ne } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { BENEFIT_OPEN_STATUSES } from '@weldsuite/app-api-client/schemas/project-governance';
import { measureMetric, nextMonthStart, previousPeriod } from '@weldsuite/flow-domain/benefit-metrics';
import type { Env } from '../types';
import { upsertMeasurement } from '../services/project-benefits';

/** The cron expression that runs this sweep: the daily tick the file purge also uses. */
export const BENEFIT_MEASURE_CRONS = ['30 3 * * *'] as const;

export function isBenefitMeasureCron(cron: string): boolean {
  return (BENEFIT_MEASURE_CRONS as readonly string[]).includes(cron);
}

/** KV flag of the (empty) one-time seed. Bump to reseed. */
export const BENEFIT_MEASURE_SEED_KEY = 'flow:benefit-measure-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const { projectBenefits } = schema;

/** The open benefits that have a catalogue metric, on every project. */
function openMeasuredBenefits(db: Database) {
  return db
    .select()
    .from(projectBenefits)
    .where(
      and(
        isNull(projectBenefits.deletedAt),
        isNull(projectBenefits.closedAt),
        ne(projectBenefits.metric, 'manual'),
        inArray(projectBenefits.status, [...BENEFIT_OPEN_STATUSES]),
      ),
    );
}

/** Measure the month before `now` for every open benefit of one workspace; returns how many got a value. */
export async function measureDueBenefits(db: Database, now: Date): Promise<number> {
  const period = previousPeriod(now);
  let measured = 0;
  for (const benefit of await openMeasuredBenefits(db)) {
    const value = await measureMetric(db, benefit.metric, benefit.metricParams, period);
    if (value === null) continue;
    await upsertMeasurement(db, {
      benefitId: benefit.id,
      projectId: benefit.projectId,
      period,
      value,
      measuredBy: null,
      now,
    });
    measured += 1;
  }
  return measured;
}

/**
 * When the workspace next has benefits to measure: the first day of the next
 * month while an open benefit with a catalogue metric remains, else null.
 */
export async function nextBenefitMeasureDueAt(db: Database, now: Date): Promise<Date | null> {
  const [first] = await openMeasuredBenefits(db).limit(1);
  return first ? nextMonthStart(now) : null;
}

/**
 * Daily tick: opens only the workspaces the `benefit_measure` due index lists
 * as due, never a tenant that is not listed.
 */
export async function runBenefitMeasure(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { measured: number }> {
  let measured = 0;
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'benefit_measure',
    label: '[BenefitMeasure]',
    seed: { key: BENEFIT_MEASURE_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      measured += await measureDueBenefits(db, now);
      return nextBenefitMeasureDueAt(db, now);
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(`[BenefitMeasure] due=${result.due} processed=${result.processed} failed=${result.failed}: ${measured} values stored`);
  }
  return { ...result, measured };
}
