import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  bareMentionIds,
  buildMessagePreview,
  formatMessagePreview,
  resolveMentionNames,
} from './message-preview';

describe('formatMessagePreview', () => {
  const names = new Map([['user_ann', 'Ann de Vries']]);

  it('renders a bare user mention as @Name', () => {
    expect(formatMessagePreview('hey <@user_ann> can you look?', names)).toBe('hey @Ann de Vries can you look?');
  });

  it('uses the inline label of a labelled user mention or entity reference', () => {
    expect(formatMessagePreview('<@user_bob:Bob> see <@ticket:tkt_1|Login broken>', names)).toBe(
      '@Bob see @Login broken',
    );
  });

  it('keeps @everyone and drops inline file tokens', () => {
    expect(formatMessagePreview('<@everyone> look <@file:att_1>  here', names)).toBe('@everyone look here');
  });

  it('reads @unknown for a member it cannot resolve, never the raw id', () => {
    expect(formatMessagePreview('ping <@user_gone>', names)).toBe('ping @unknown');
  });

  it('cuts long previews at 100 characters', () => {
    const preview = formatMessagePreview('a'.repeat(150), names);
    expect(preview).toBe(`${'a'.repeat(100)}...`);
  });
});

describe('bareMentionIds', () => {
  it('lists only the tokens that need a name lookup, once each', () => {
    expect(
      bareMentionIds('<@u1> <@u1> <@u2:Two> <@ticket:t|T> <@everyone> <@file:a> <@agt_1>'),
    ).toEqual(['u1', 'agt_1']);
  });
});

describe('resolveMentionNames / buildMessagePreview', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_1', userId: 'user_ann', name: 'Ann' },
      { id: 'wm_2', userId: 'user_noname', name: null },
    ]);
    await db.insert(schema.weldagentAgents).values({ id: 'agt_1', name: 'Triage bot' });
  });

  it('looks up members and agents by id', async () => {
    const names = await resolveMentionNames(db, '<@user_ann> <@agt_1> <@user_noname> <@user_gone>');
    expect(Object.fromEntries(names)).toEqual({ user_ann: 'Ann', agt_1: 'Triage bot' });
  });

  it('builds the preview a notification shows', async () => {
    expect(await buildMessagePreview(db, '<@user_ann> and <@agt_1>, thoughts?')).toBe(
      '@Ann and @Triage bot, thoughts?',
    );
  });

  it('skips the lookup when nothing needs resolving', async () => {
    expect(await buildMessagePreview(db, 'plain text')).toBe('plain text');
  });
});
