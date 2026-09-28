import { describe, expect, it } from 'vitest';
import {
  mergeAgentRoomPolicy,
  parseAgentRoomPolicy,
  selectAgentsToReply,
} from './agent-room-policy';

describe('parseAgentRoomPolicy', () => {
  it('defaults to mentions / 2 hops', () => {
    expect(parseAgentRoomPolicy(null)).toEqual({
      agentReplyPolicy: 'mentions',
      agentMaxHops: 2,
    });
  });

  it('reads metadata fields', () => {
    expect(
      parseAgentRoomPolicy({ agentReplyPolicy: 'always', agentMaxHops: 4 }),
    ).toEqual({ agentReplyPolicy: 'always', agentMaxHops: 4 });
  });

  it('clamps hops', () => {
    expect(parseAgentRoomPolicy({ agentMaxHops: 99 }).agentMaxHops).toBe(5);
    expect(parseAgentRoomPolicy({ agentMaxHops: 0 }).agentMaxHops).toBe(1);
  });
});

describe('mergeAgentRoomPolicy', () => {
  it('preserves unrelated metadata keys', () => {
    const merged = mergeAgentRoomPolicy({ foo: 'bar' }, { agentReplyPolicy: 'none' });
    expect(merged).toMatchObject({
      foo: 'bar',
      agentReplyPolicy: 'none',
      agentMaxHops: 2,
    });
  });
});

describe('selectAgentsToReply', () => {
  const members = ['agt_a', 'agt_b', 'agt_c'];

  it('mentions policy only returns mentioned members', () => {
    expect(
      selectAgentsToReply({
        policy: 'mentions',
        agentMemberIds: members,
        mentionedAgentIds: ['agt_b', 'agt_x'],
        authorType: 'user',
        authorId: 'user_1',
        hop: 0,
        maxHops: 2,
      }),
    ).toEqual(['agt_b']);
  });

  it('always policy fans out to all agents on human messages', () => {
    expect(
      selectAgentsToReply({
        policy: 'always',
        agentMemberIds: members,
        mentionedAgentIds: [],
        authorType: 'user',
        authorId: 'user_1',
        hop: 0,
        maxHops: 2,
      }),
    ).toEqual(members);
  });

  it('always policy only follows mentions on agent messages', () => {
    expect(
      selectAgentsToReply({
        policy: 'always',
        agentMemberIds: members,
        mentionedAgentIds: ['agt_c'],
        authorType: 'agent',
        authorId: 'agt_a',
        hop: 1,
        maxHops: 2,
      }),
    ).toEqual(['agt_c']);
  });

  it('respects hop limit and none policy', () => {
    expect(
      selectAgentsToReply({
        policy: 'mentions',
        agentMemberIds: members,
        mentionedAgentIds: ['agt_a'],
        authorType: 'user',
        authorId: 'user_1',
        hop: 3,
        maxHops: 2,
      }),
    ).toEqual([]);
    expect(
      selectAgentsToReply({
        policy: 'none',
        agentMemberIds: members,
        mentionedAgentIds: ['agt_a'],
        authorType: 'user',
        authorId: 'user_1',
        hop: 0,
        maxHops: 2,
      }),
    ).toEqual([]);
  });

  it('never selects the author agent', () => {
    expect(
      selectAgentsToReply({
        policy: 'mentions',
        agentMemberIds: members,
        mentionedAgentIds: ['agt_a', 'agt_b'],
        authorType: 'agent',
        authorId: 'agt_a',
        hop: 1,
        maxHops: 2,
      }),
    ).toEqual(['agt_b']);
  });
});
