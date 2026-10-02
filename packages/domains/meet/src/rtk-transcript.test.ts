import { describe, expect, it } from 'vitest';
import { parseCsvRows, parseRtkTranscript } from './rtk-transcript';

describe('parseCsvRows', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    expect(parseCsvRows('"1","a ""b"", c","line1\nline2"\r\n"2","x","y"')).toEqual([
      ['1', 'a "b", c', 'line1\nline2'],
      ['2', 'x', 'y'],
    ]);
  });
});

describe('parseRtkTranscript', () => {
  it('parses the documented CSV row order and derives end times and speakers', () => {
    const csv = [
      '"1000","peer-123","user-456","cust-789","Alice","Hello everyone"',
      '"3000","peer-234","user-567","cust-890","Bob","Hi Alice, how are you"',
      '"9000","peer-999","user-456","cust-789","Alice","Good, thanks"',
    ].join('\n');
    const parsed = parseRtkTranscript(csv);
    expect(parsed.format).toBe('csv');
    expect(parsed.speakerCount).toBe(2);
    expect(parsed.segments).toEqual([
      { speakerId: 0, speakerLabel: 'Alice', speakerName: 'Alice', text: 'Hello everyone', start: 1, end: 3 },
      { speakerId: 1, speakerLabel: 'Bob', speakerName: 'Bob', text: 'Hi Alice, how are you', start: 3, end: 9 },
      { speakerId: 0, speakerLabel: 'Alice', speakerName: 'Alice', text: 'Good, thanks', start: 9, end: 12 },
    ]);
  });

  it('parses the JSON array shape and keys speakers by custom participant id', () => {
    const json = JSON.stringify([
      { startTime: 3000, endTime: 4500, sentence: 'Hi Alice', peerData: { id: 'p2', userId: 'u2', displayName: 'Bob', cpi: 'cust-890' } },
      { startTime: 1000, endTime: 2500, sentence: 'Hello everyone', peerData: { id: 'p1', userId: 'u1', displayName: 'Alice', cpi: 'cust-789' } },
      { startTime: 5000, endTime: 6000, sentence: 'Back again', peerData: { id: 'p3', userId: 'u1', displayName: 'Alice', cpi: 'cust-789' } },
    ]);
    const parsed = parseRtkTranscript(json);
    expect(parsed.format).toBe('json');
    expect(parsed.speakerCount).toBe(2);
    expect(parsed.segments.map((s) => [s.text, s.speakerId, s.start, s.end])).toEqual([
      ['Hello everyone', 0, 1, 2.5],
      ['Hi Alice', 1, 3, 4.5],
      ['Back again', 0, 5, 6],
    ]);
  });

  it('skips header rows and empty text, and tolerates an empty file', () => {
    const csv = 'start,peer,user,cpi,name,text\n"500","p","u","c","Zed",""\n"700","p","u","c","Zed","Hi"';
    const parsed = parseRtkTranscript(csv);
    expect(parsed.segments).toHaveLength(1);
    expect(parseRtkTranscript('').segments).toEqual([]);
  });
});
