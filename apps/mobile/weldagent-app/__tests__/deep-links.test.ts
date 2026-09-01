import { resolveWeldAgentDeepLink, routeForDeepLink } from '@/utils/deep-links';

describe('resolveWeldAgentDeepLink', () => {
  it('prefers explicit conversationId from Expo data', () => {
    expect(
      resolveWeldAgentDeepLink({ conversationId: 'conv_abc' }),
    ).toEqual({ conversationId: 'conv_abc', agentId: undefined, runId: undefined });
  });

  it('scrapes actionUrl for chat and agent/run targets', () => {
    expect(
      resolveWeldAgentDeepLink({ actionUrl: '/weldagent/chat/conv_99' }),
    ).toMatchObject({ conversationId: 'conv_99' });

    expect(
      resolveWeldAgentDeepLink({
        actionUrl: '/weldagent/agent/agt_1/run/run_2',
        agentId: 'agt_1',
        runId: 'run_2',
      }),
    ).toEqual({ conversationId: undefined, agentId: 'agt_1', runId: 'run_2' });
  });

  it('rejects junk ids', () => {
    expect(resolveWeldAgentDeepLink({ conversationId: 'not a id!' })).toBeNull();
    expect(resolveWeldAgentDeepLink({})).toBeNull();
    expect(resolveWeldAgentDeepLink(undefined)).toBeNull();
  });
});

describe('routeForDeepLink', () => {
  it('opens the chat thread when a conversation is present', () => {
    expect(routeForDeepLink({ conversationId: 'conv_1' })).toBe('/chat/conv_1');
  });

  it('opens the agent when only an agent id is present', () => {
    expect(routeForDeepLink({ agentId: 'agt_1', runId: 'run_9' })).toBe('/agent/agt_1');
  });
});
