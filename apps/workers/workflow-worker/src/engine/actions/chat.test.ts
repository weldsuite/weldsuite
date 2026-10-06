import { describe, it, expect, vi } from 'vitest';
import { handlePostChatMessage } from './chat';
import { makeActionContext } from '../../test/ctx';
import type { WorkflowEnv } from '../types';

function connectInternal(response: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(response), { status }));
  return { env: { CONNECT_INTERNAL: { fetch } } as unknown as WorkflowEnv, fetch };
}

const owned = { workspaceId: 'ws_1', userId: 'system', ownerUserId: 'owner_1' };
const ok = { success: true, message: { id: 'msg_1', channelId: 'chan_1' } };

describe('post_chat_message', () => {
  it('sends the message with the owner as actor plus the workflow id/name from the trigger data', async () => {
    const { env, fetch } = connectInternal(ok);
    const res = await handlePostChatMessage(
      { channelId: 'chan_1', message: ' Report is ready ', mentions: 'member_2, , member_3' },
      makeActionContext({
        env,
        tenant: owned,
        chainDepth: 2,
        triggerData: { workflowId: 'wf_1', workflowName: 'Weekly Digest' },
      }),
    );

    expect(res).toEqual({ messageId: 'msg_1', channelId: 'chan_1' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/post-chat-message');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 2,
      channelId: 'chan_1',
      content: 'Report is ready',
      mentions: ['member_2', 'member_3'],
      workflowId: 'wf_1',
      workflowName: 'Weekly Digest',
    });
  });

  it('accepts `content` as an alias for `message`, and omits workflowId/workflowName when the trigger data has none', async () => {
    const { env, fetch } = connectInternal(ok);
    await handlePostChatMessage({ channelId: 'chan_1', content: 'Hi team' }, makeActionContext({ env, tenant: owned }));
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.content).toBe('Hi team');
    expect(body.workflowId).toBeUndefined();
    expect(body.workflowName).toBeUndefined();
  });

  it('fails without retrying when the run has no owner', async () => {
    const { env } = connectInternal(ok);
    await expect(
      handlePostChatMessage(
        { channelId: 'chan_1', message: 'x' },
        makeActionContext({ env, tenant: { workspaceId: 'ws_1', userId: 'u' } }),
      ),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/no owner/) });
  });

  it('needs a channel and a message', async () => {
    const { env } = connectInternal(ok);
    await expect(
      handlePostChatMessage({ message: 'x' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toThrow(/channel/);
    await expect(
      handlePostChatMessage({ channelId: 'chan_1' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toThrow(/message/);
  });

  it("turns the owner's missing channel access into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have access to this channel" },
      403,
    );
    await expect(
      handlePostChatMessage({ channelId: 'chan_private', message: 'x' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({
      name: 'NonRetryableStepError',
      message: expect.stringMatching(/access to this channel/),
    });
  });
});
