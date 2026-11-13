import { describe, expect, it } from 'vitest';
import { defaultFormResponseColumns, questionColumnKey, sheetFormColumns } from './sheet-columns';

const field = (id: string, type: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type, title, properties: {}, ...extra });

const definition = {
  blocks: [
    field('b_abc123', 'short_text', 'Your name'),
    field('b_pwd', 'short_text', 'Password', { sensitive: true }),
    field('b_up', 'file_upload', 'CV'),
    field('x-odd-id', 'short_text', 'Odd id'),
    field('b_mail', 'email', 'Email'),
  ],
  hidden: [{ name: 'utm' }, { name: 'bad name' }],
} as never;

describe('sheet form columns', () => {
  it('maps a block id to its column key', () => {
    expect(questionColumnKey('b_x7Kp2QaZ')).toBe('qbx7Kp2QaZ');
    expect(questionColumnKey('x7')).toBeNull();
  });

  it('lists questions and hidden fields, leaving out sensitive, file and odd ids', () => {
    expect(sheetFormColumns(definition).map((c) => c.key)).toEqual(['qbabc123', 'qbmail', 'hutm']);
  });

  it('starts with number, submitted, email, then the questions', () => {
    const { columns, headers } = defaultFormResponseColumns(definition, (k) => `meta:${k}`);
    expect(columns).toEqual(['number', 'submittedAt', 'respondentEmail', 'qbabc123', 'qbmail']);
    expect(headers).toEqual(['meta:number', 'meta:submittedAt', 'meta:respondentEmail', 'Your name', 'Email']);
  });
});
