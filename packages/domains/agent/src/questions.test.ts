import { describe, expect, it } from 'vitest';
import {
  encodeQuestionMarker,
  parseAgentQuestion,
  splitQuestionMarkers,
} from '@weldsuite/app-api-client/schemas/weldagent-questions';
import { PLATFORM_TOOLS } from './tools';

const question = {
  question: 'What should I focus on?',
  options: [{ label: 'New tickets' }, { label: 'Overdue tasks', description: 'Across all projects' }],
};

describe('ask_user questions', () => {
  it('round-trips a question through the stream marker', () => {
    const raw = `Sure.\n\n${encodeQuestionMarker(question)}`;
    expect(splitQuestionMarkers(raw)).toEqual({ text: 'Sure.', questions: [question] });
  });

  it('hides a marker that is still streaming', () => {
    const raw = `Sure.\n\n${encodeQuestionMarker(question).slice(0, 20)}`;
    expect(splitQuestionMarkers(raw)).toEqual({ text: 'Sure.', questions: [] });
  });

  it('rejects questions without enough options', () => {
    expect(parseAgentQuestion({ question: 'Yes?', options: [{ label: 'Yes' }] })).toBeNull();
    expect(parseAgentQuestion(question)).toEqual(question);
  });

  it('tells the agent to wait for the answer', async () => {
    const tool = PLATFORM_TOOLS.find((t) => t.id === 'agent.ask_user');
    expect(tool?.name).toBe('ask_user');
    const result = await tool!.execute({} as never, question);
    expect(result).toMatchObject({ ok: true, shownToUser: true, options: ['New tickets', 'Overdue tasks'] });
    await expect(tool!.execute({} as never, { question: 'Hm?', options: [] })).rejects.toThrow();
  });
});
