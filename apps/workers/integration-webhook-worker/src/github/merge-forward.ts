/**
 * Forwards GitHub App events to WeldMerge (pull requests, reviews, checks, issues,
 * issue comments and the installation lifecycle) (merge-api's `MergeInternal`
 * entrypoint, bound as MERGE_INTERNAL). Called after the App's HMAC is verified
 * and the workspace is resolved; fire-and-forget, so a missing binding or a
 * failing merge-api never changes the webhook's answer, and the WeldFlow
 * handling next to it is untouched.
 */

import type {
  MergeGithubEventEnvelope,
  MergeGithubForwardedEvent,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  MergeProviderEventAck,
  MergeProviderEventEnvelope,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';

/** The part of `MergeInternal` this worker calls (RPC over the service binding). */
export interface MergeInternalBinding {
  githubEvent(envelope: MergeGithubEventEnvelope): Promise<unknown>;
  /** GitLab, Bitbucket and Azure DevOps webhooks (merge/provider-webhook.ts). */
  providerEvent?(envelope: MergeProviderEventEnvelope): Promise<MergeProviderEventAck>;
}

const FORWARDED: ReadonlySet<string> = new Set<MergeGithubForwardedEvent>([
  'pull_request',
  'pull_request_review',
  'check_suite',
  'installation_repositories',
  'issues',
  'issue_comment',
  'installation',
]);

export function isForwardedToMerge(event: string): event is MergeGithubForwardedEvent {
  return FORWARDED.has(event);
}

export interface MergeForwardInput {
  /** The workspace's Clerk org id, as this worker resolves installations today. */
  workspaceId: string;
  event: MergeGithubForwardedEvent;
  deliveryId: string;
  payload: Record<string, unknown>;
}

/** Never throws: logs and returns when the binding is missing or the call fails. */
export async function forwardToMerge(env: { MERGE_INTERNAL?: MergeInternalBinding }, input: MergeForwardInput): Promise<void> {
  if (!env.MERGE_INTERNAL) {
    console.warn(`[GitHub Webhook] MERGE_INTERNAL binding missing; ${input.event} not forwarded to WeldMerge (delivery: ${input.deliveryId})`);
    return;
  }
  try {
    await env.MERGE_INTERNAL.githubEvent({
      workspaceId: input.workspaceId,
      event: input.event,
      deliveryId: input.deliveryId || null,
      payload: input.payload,
    });
  } catch (err) {
    console.error(`[GitHub Webhook] WeldMerge refused ${input.event} (delivery: ${input.deliveryId}):`, err);
  }
}
