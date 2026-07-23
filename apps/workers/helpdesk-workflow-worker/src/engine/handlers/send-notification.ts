/**
 * Send Notification Step Handler
 *
 * Publishes a workflow notification to the workspace's realtime channel
 * for real-time delivery to agents in the platform.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';
import { publishToRealtimeChannel } from '../../lib/realtime-publisher';

export const sendNotificationHandler: StepHandler = {
  type: 'send_notification',

  async execute(ctx: StepContext): Promise<StepResult> {
    const { env, conversationId, workspaceId } = ctx.options;

    const recipientId = String(ctx.inputs.recipientId || '');
    const departmentId = String(ctx.inputs.departmentId || '');
    const message = String(ctx.inputs.message || '');

    if (!message) {
      return { success: false, error: 'Missing required field: message' };
    }

    const notificationPayload = {
      conversationId,
      message,
      recipientId: recipientId || undefined,
      departmentId: departmentId || undefined,
      timestamp: new Date().toISOString(),
      workspaceId,
    };

    try {
      await publishToRealtimeChannel(
        env,
        `workspace:${workspaceId}`,
        'notification:workflow',
        notificationPayload,
      );
    } catch (err) {
      console.error('[Send Notification] realtime publish error:', err);
      return {
        success: false,
        recipientId,
        message,
        error: `Notification publish failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }

    return {
      success: true,
      recipientId,
      message,
    };
  },
};
