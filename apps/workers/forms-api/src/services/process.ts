/**
 * Starting ProcessResponse for a response. One run per response: the instance
 * id is the response id, so a second start finds the first; one still running
 * or done is left alone, one that failed is restarted. An edit of a completed
 * response gets an id of its own (`<responseId>-update-<n>`): Workflow ids are
 * never reused. Without a Workflow binding the steps run in `waitUntil`.
 */

import type { Env } from '../types';
import type { ProcessResponseParams } from '../workflows/process-params';
import { inlineSteps, runProcessResponse } from '../workflows/process-response';

/** What sets a run's instance id apart from the response id: a retry, an edit, or nothing for the first run. */
function instanceSuffix(params: ProcessResponseParams): 'retry' | 'update' | null {
  if (params.retryIntegrationId) return 'retry';
  if (params.mode === 'update') return 'update';
  return null;
}

export async function startProcessing(env: Env, params: ProcessResponseParams, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const workflow = env.PROCESS_RESPONSE;
  if (!workflow) {
    waitUntil(
      runProcessResponse(env, params, inlineSteps).catch((err) => {
        console.error(`[forms-api] processing ${params.responseId} failed:`, err);
      }),
    );
    return;
  }
  const suffix = instanceSuffix(params);
  const id = suffix ? `${params.responseId}-${suffix}-${Date.now().toString(36)}` : params.responseId;
  try {
    await workflow.create({ id, params });
  } catch (err) {
    const instance = await workflow.get(id).catch(() => null);
    if (!instance) throw err;
    const { status } = await instance.status();
    if (status === 'errored' || status === 'terminated') await instance.restart();
  }
}
