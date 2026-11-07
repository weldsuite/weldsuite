import { describe, expect, it } from 'vitest';
import { assigneePatch, assigneeValue, NO_ASSIGNEE } from './assignee-lib';

describe('assignee value', () => {
  it('prefers the agent, then the member, then none', () => {
    expect(assigneeValue({ assigneeUserId: 'user_1', agentId: 'agt_1' })).toBe('agent:agt_1');
    expect(assigneeValue({ assigneeUserId: 'user_1', agentId: null })).toBe('user:user_1');
    expect(assigneeValue({ assigneeUserId: null, agentId: null })).toBe(NO_ASSIGNEE);
  });

  it('turns a pick into a patch that clears the other kind', () => {
    expect(assigneePatch('agent:agt_1')).toEqual({ agentId: 'agt_1', assigneeUserId: null });
    expect(assigneePatch('user:user_2')).toEqual({ assigneeUserId: 'user_2', agentId: null });
    expect(assigneePatch(NO_ASSIGNEE)).toEqual({ assigneeUserId: null, agentId: null });
  });
});
