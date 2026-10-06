/**
 * WeldChat action: post_chat_message.
 *
 * Like crm.ts's create_contact / update_contact, this never writes the
 * chat_messages table directly: it calls connect-api's internal
 * `/workflow-actions/post-chat-message` route (over the `CONNECT_INTERNAL`
 * entrypoint), which checks the workflow owner's `channels:create` permission
 * AND their access to the target channel (public, or a membership row — same
 * boundary chat-api's human send route enforces), then posts through
 * `@weldsuite/chat-domain/post-system-message` and publishes
 * `chat_message:created` with the run's chain depth.
 *
 * The message is attributed to the WORKFLOW, never the owner: connect-api
 * stamps `authorType: 'system'` / `authorId: 'workflow:<workflowId>'`, so a
 * chat it posts to never looks like it was typed by a teammate.
 */

import type { ActionHandler } from '../types';
import { NonRetryableStepError } from '../errors';
import { optionalText, postInternalApi, workflowActor } from './helpers';

/** Wire contract with connect-api's post-chat-message route. */
export interface PostChatMessageActionResponse {
  success: boolean;
  message: { id: string; channelId: string };
}

/** A comma-separated list (or an array) of mentioned user ids, trimmed and non-empty. */
function mentionList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
  const list = items.map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export const handlePostChatMessage: ActionHandler = async (inputs, ctx) => {
  const channelId = optionalText(inputs.channelId);
  if (!channelId) throw new NonRetryableStepError('Choose a channel to post to');
  const content = optionalText(inputs.message ?? inputs.content);
  if (!content) throw new NonRetryableStepError('Write a message to post');

  // The run's enriched trigger payload carries the workflow's own id/name
  // (buildTriggerData, apps/workers/workflow-worker/src/engine/trigger-data.ts)
  // so the message can be attributed to the workflow rather than its owner.
  const triggerData = ctx.triggerData as Record<string, unknown> | undefined;
  const workflowId = typeof triggerData?.workflowId === 'string' ? triggerData.workflowId : undefined;
  const workflowName =
    typeof triggerData?.workflowName === 'string' && triggerData.workflowName ? triggerData.workflowName : undefined;

  const result = await postInternalApi<PostChatMessageActionResponse>(
    ctx.env,
    '/workflow-actions/post-chat-message',
    {
      ...workflowActor(ctx),
      channelId,
      content,
      mentions: mentionList(inputs.mentions),
      workflowId,
      workflowName,
    },
    'Post chat message',
    'CONNECT_INTERNAL',
  );
  return { messageId: result.message.id, channelId: result.message.channelId };
};
