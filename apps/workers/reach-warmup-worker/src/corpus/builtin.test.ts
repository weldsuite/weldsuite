import { describe, expect, it } from 'vitest';
import { BUILTIN_CORPUS } from './builtin';
import { PLACEHOLDER_NAMES } from './constants';
import { fillPlaceholders } from './render';
import { findContentIssue, parseCorpusThread, parseCorpusThreads } from './validate';

describe('built-in corpus', () => {
  it('has at least 60 threads', () => {
    expect(BUILTIN_CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  it('passes the same validator as a stored corpus, every thread', () => {
    const rejected = BUILTIN_CORPUS.filter((thread) => parseCorpusThread(thread) === null).map((thread) => thread.id);
    expect(rejected).toEqual([]);
    expect(parseCorpusThreads(BUILTIN_CORPUS)).toHaveLength(BUILTIN_CORPUS.length);
  });

  it('has stable, unique ids in order', () => {
    const ids = BUILTIN_CORPUS.map((thread) => thread.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('builtin-001');
    expect(ids.at(-1)).toBe(`builtin-${String(ids.length).padStart(3, '0')}`);
    ids.forEach((id, index) => expect(id).toBe(`builtin-${String(index + 1).padStart(3, '0')}`));
  });

  it('has threads of 2 to 4 messages, alternating starter and responder', () => {
    const counts = new Set<number>();
    for (const thread of BUILTIN_CORPUS) {
      expect(thread.messages.length).toBeGreaterThanOrEqual(2);
      expect(thread.messages.length).toBeLessThanOrEqual(4);
      counts.add(thread.messages.length);
      thread.messages.forEach((message, index) => {
        expect(message.author).toBe(index % 2 === 0 ? 'starter' : 'responder');
      });
    }
    expect([...counts].sort()).toEqual([2, 3, 4]);
  });

  it('has plain subjects without "Re:", all different', () => {
    const subjects = BUILTIN_CORPUS.map((thread) => thread.subject);
    expect(new Set(subjects.map((subject) => subject.toLowerCase())).size).toBe(subjects.length);
    for (const subject of subjects) {
      expect(subject).not.toMatch(/^re:/i);
      expect(findContentIssue(subject)).toBeNull();
    }
  });

  it('contains no link, address, phone number, currency symbol or spammy word', () => {
    for (const thread of BUILTIN_CORPUS) {
      for (const message of thread.messages) {
        expect(findContentIssue(message.body), `${thread.id}: ${message.body.slice(0, 40)}`).toBeNull();
      }
    }
  });

  it('uses only the four name placeholders', () => {
    const used = new Set<string>();
    for (const thread of BUILTIN_CORPUS) {
      for (const message of thread.messages) {
        for (const match of message.body.matchAll(/\{\{([A-Za-z]+)\}\}/g)) used.add(match[1] ?? '');
      }
    }
    expect([...used].every((name) => (PLACEHOLDER_NAMES as readonly string[]).includes(name))).toBe(true);
    expect(used.has('senderFirstName')).toBe(true);
    expect(used.has('recipientFirstName')).toBe(true);
  });

  it('varies in length and in how messages open and close', () => {
    const bodies = BUILTIN_CORPUS.flatMap((thread) => thread.messages.map((message) => message.body));
    const withGreeting = bodies.filter((body) => /^(?:hi|hello) /i.test(body)).length;
    const withoutGreeting = bodies.length - withGreeting;
    const withSignOff = bodies.filter((body) => /\n\{\{senderFirstName\}\}/.test(body)).length;
    const lengths = bodies.map((body) => body.length);

    expect(withGreeting).toBeGreaterThan(20);
    expect(withoutGreeting).toBeGreaterThan(20);
    expect(withSignOff).toBeGreaterThan(40);
    expect(bodies.length - withSignOff).toBeGreaterThan(10);
    expect(Math.min(...lengths)).toBeLessThan(160);
    expect(Math.max(...lengths)).toBeGreaterThan(350);
  });

  it('renders without leftover placeholders for any pair', () => {
    const sender = { firstName: 'Mia', lastName: 'Jansen' };
    const recipient = { firstName: 'Tom', lastName: 'Bakker' };
    for (const thread of BUILTIN_CORPUS) {
      for (const message of thread.messages) {
        const text = fillPlaceholders(message.body, {
          senderFirstName: sender.firstName,
          senderLastName: sender.lastName,
          recipientFirstName: recipient.firstName,
          recipientLastName: recipient.lastName,
        });
        expect(text).not.toContain('{{');
        expect(text).not.toContain('}}');
      }
    }
  });
});
