import { describe, expect, it } from 'vitest';
import { notificationPreview, stripMarkdown } from './preview';

describe('stripMarkdown', () => {
  it('drops bold and italic markers', () => {
    expect(stripMarkdown("I'm set up as **CRM QA Assistant**")).toBe("I'm set up as CRM QA Assistant");
    expect(stripMarkdown('This is __very__ and *quite* and _really_ good')).toBe('This is very and quite and really good');
    expect(stripMarkdown('~~old~~ new')).toBe('old new');
  });

  it('drops heading, quote and list markers', () => {
    expect(stripMarkdown('## Summary\n- one\n* two\n+ three\n1. four\n2) five\n> quoted')).toBe(
      'Summary\none\ntwo\nthree\nfour\nfive\nquoted',
    );
  });

  it('keeps the label of links and the alt text of images', () => {
    expect(stripMarkdown('See [the board](https://app.weldsuite.org/b/1 "Board") now')).toBe('See the board now');
    expect(stripMarkdown('![chart](https://x.test/c.png) done')).toBe('chart done');
    expect(stripMarkdown('<https://weldsuite.org>')).toBe('https://weldsuite.org');
  });

  it('unwraps code spans and fences', () => {
    expect(stripMarkdown('run `pnpm test` now')).toBe('run pnpm test now');
    expect(stripMarkdown('```ts\nconst a = 1;\n```')).toBe('const a = 1;\n');
  });

  it('removes horizontal rules', () => {
    expect(stripMarkdown('before\n---\nafter')).toBe('before\n\nafter');
  });

  it('leaves words with underscores, math-like asterisks and mention tokens alone', () => {
    expect(stripMarkdown('the project_task_created event')).toBe('the project_task_created event');
    expect(stripMarkdown('2 * 3 = 6 and 4 * 5')).toBe('2 * 3 = 6 and 4 * 5');
    expect(stripMarkdown('hey <@user_2x_abc> and <@agt_1>')).toBe('hey <@user_2x_abc> and <@agt_1>');
  });

  it('keeps plain text unchanged', () => {
    expect(stripMarkdown('Created the task. Anything else?')).toBe('Created the task. Anything else?');
  });
});

describe('notificationPreview', () => {
  it('is one plain line', () => {
    expect(notificationPreview("**Done.**\n\n- created the task\n- linked it")).toBe('Done. created the task linked it');
  });

  it('cuts long text with an ellipsis', () => {
    const preview = notificationPreview('word '.repeat(100), 50);
    expect(preview).toHaveLength(50);
    expect(preview.endsWith('…')).toBe(true);
  });
});
