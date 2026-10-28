import { describe, expect, it } from 'vitest';
import { describeRecordTokens, describeUserTags, taggedRecords, taggedSheetsIn } from './record-tokens';

describe('records tagged in a message', () => {
  it('finds record tags, in order and each once', () => {
    expect(taggedRecords('Fill <@sheet:sht_1|Budget> from <@customer:cmp_1|Acme> and <@sheet:sht_1|Budget>')).toEqual([
      { type: 'sheet', id: 'sht_1', label: 'Budget' },
      { type: 'customer', id: 'cmp_1', label: 'Acme' },
    ]);
  });

  it('leaves out people, agents, files and anything malformed', () => {
    expect(
      taggedRecords('<@user_1> <@user_2:Ann> <@agt_1> <@everyone> <@file:att_1> <@sheet:|Nameless> <@nope:x|Y>'),
    ).toEqual([]);
  });

  it('keeps a tag without a label', () => {
    expect(taggedRecords('<@sheet:sht_1>')).toEqual([{ type: 'sheet', id: 'sht_1', label: null }]);
    expect(taggedRecords('<@sheet:sht_1|>')).toEqual([{ type: 'sheet', id: 'sht_1', label: null }]);
  });
});

describe('spelling tags out for a model', () => {
  it('names the record type, its label and id, and leaves other tokens alone', () => {
    expect(describeRecordTokens('<@agt_1> add a total row to <@sheet:sht_1|Budget>')).toBe(
      '<@agt_1> add a total row to spreadsheet "Budget" (id sht_1)',
    );
    expect(describeRecordTokens('See <@contact:per_1|Ann de Vries> and <@sheet:sht_2>')).toBe(
      'See person "Ann de Vries" (id per_1) and spreadsheet (id sht_2)',
    );
    expect(describeRecordTokens('no tags here')).toBe('no tags here');
  });

  it('spells out only what the user wrote', () => {
    expect(
      describeUserTags([
        { role: 'user' as const, content: 'Fix <@sheet:sht_1|Budget>' },
        { role: 'assistant' as const, content: 'Keeps <@sheet:sht_1|Budget>' },
      ]),
    ).toEqual([
      { role: 'user', content: 'Fix spreadsheet "Budget" (id sht_1)' },
      { role: 'assistant', content: 'Keeps <@sheet:sht_1|Budget>' },
    ]);
  });
});

describe('spreadsheets tagged in a conversation', () => {
  it('collects the sheets the user tagged, oldest first, each once', () => {
    expect(
      taggedSheetsIn([
        { role: 'user', content: 'Look at <@sheet:sht_1|Budget>' },
        { role: 'assistant', content: 'Also <@sheet:sht_9|Not from the user>' },
        { role: 'user', content: 'and <@sheet:sht_2|Forecast> with <@ticket:tkt_1|Refund>, then <@sheet:sht_1|Budget>' },
      ]),
    ).toEqual([
      { id: 'sht_1', label: 'Budget' },
      { id: 'sht_2', label: 'Forecast' },
    ]);
  });
});
