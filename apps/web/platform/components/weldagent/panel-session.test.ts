import { describe, expect, it } from 'vitest';
import { getDefaultAgentSuggestions } from './agent-chat-input';
import { messagesToRemember } from './panel-session';

describe('getDefaultAgentSuggestions', () => {
  it('offers chips the general assistant can answer from the user\'s own data', () => {
    expect(getDefaultAgentSuggestions()).toEqual([
      "What's on my plate today?",
      'Show my open tasks',
      'Find a contact in the CRM',
    ]);
  });
});

describe('messagesToRemember', () => {
  const user = { id: 'u1', role: 'user' as const, content: 'Hi' };

  it('keeps a finished conversation as it is', () => {
    const messages = [user, { id: 'a1', role: 'assistant' as const, content: 'Hello' }];
    expect(messagesToRemember(messages)).toBe(messages);
  });

  it('drops the empty bubble of a reply that has not started streaming', () => {
    const messages = [user, { id: 'a1', role: 'assistant' as const, content: '' }];
    expect(messagesToRemember(messages)).toEqual([user]);
  });

  it('keeps a reply that was cut off mid-way', () => {
    const messages = [user, { id: 'a1', role: 'assistant' as const, content: 'Your tasks are' }];
    expect(messagesToRemember(messages)).toBe(messages);
  });
});
