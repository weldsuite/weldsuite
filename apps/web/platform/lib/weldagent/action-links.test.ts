import { describe, expect, it } from 'vitest';
import { webHrefForAction } from './action-links';

describe('webHrefForAction', () => {
  it('opens chat replies on the agents page', () => {
    expect(webHrefForAction('/weldagent/chat/conv_123')).toBe('/agents?conversation=conv_123');
  });

  it('opens run results in the agent activity', () => {
    expect(webHrefForAction('/weldagent/agent/agt_1/run/run_9')).toBe('/agents/agt_1?settings=activity');
  });

  it('opens approval requests on the agent', () => {
    expect(webHrefForAction('/weldagent/agent/agt_1')).toBe('/agents/agt_1');
  });

  it('leaves other links alone', () => {
    expect(webHrefForAction('/weldcrm/people/p_1')).toBe('/weldcrm/people/p_1');
  });
});
