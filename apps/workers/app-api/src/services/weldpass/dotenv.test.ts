import { describe, expect, it } from 'vitest';
import { isValidSecretKey, parseDotenv, renderDotenv } from './dotenv';

describe('parseDotenv', () => {
  it('reads plain assignments', () => {
    const { values } = parseDotenv('FOO=bar\nBAZ=qux');
    expect(values).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    const { values, skipped } = parseDotenv('# a comment\n\nFOO=bar\n');
    expect(values).toEqual({ FOO: 'bar' });
    expect(skipped).toEqual([]);
  });

  it('strips an export prefix', () => {
    expect(parseDotenv('export FOO=bar').values).toEqual({ FOO: 'bar' });
  });

  it('expands escapes inside double quotes only', () => {
    expect(parseDotenv('KEY="line1\\nline2"').values.KEY).toBe('line1\nline2');
    expect(parseDotenv("KEY='line1\\nline2'").values.KEY).toBe('line1\\nline2');
  });

  it('keeps a hash that is part of the value', () => {
    expect(parseDotenv('PASSWORD=pass#word').values.PASSWORD).toBe('pass#word');
    expect(parseDotenv('PASSWORD=secret # note').values.PASSWORD).toBe('secret');
  });

  it('handles CRLF input', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n').values).toEqual({ A: '1', B: '2' });
  });

  it('preserves values containing "="', () => {
    expect(parseDotenv('URL=postgres://u:p@h/db?x=1&y=2').values.URL).toBe(
      'postgres://u:p@h/db?x=1&y=2',
    );
  });

  it('reports lines it could not read instead of dropping them silently', () => {
    const { values, skipped } = parseDotenv('GOOD=1\njust some prose\n9BAD=2');
    expect(values).toEqual({ GOOD: '1' });
    expect(skipped).toEqual([
      { line: 2, reason: 'No "=" found' },
      { line: 3, reason: '"9BAD" is not a valid variable name' },
    ]);
  });

  it('accepts an empty value', () => {
    expect(parseDotenv('EMPTY=').values.EMPTY).toBe('');
  });
});

describe('renderDotenv', () => {
  it('round-trips through the parser', () => {
    const values = {
      SIMPLE: 'value',
      WITH_SPACE: 'two words',
      WITH_NEWLINE: 'line1\nline2',
      WITH_QUOTE: 'say "hi"',
      EMPTY: '',
      URL: 'postgres://u:p@h/db',
    };
    expect(parseDotenv(renderDotenv(values)).values).toEqual(values);
  });

  it('sorts keys so diffs stay readable', () => {
    expect(renderDotenv({ B: '2', A: '1' })).toBe('A=1\nB=2\n');
  });
});

describe('isValidSecretKey', () => {
  it('accepts conventional names', () => {
    expect(isValidSecretKey('DATABASE_URL')).toBe(true);
    expect(isValidSecretKey('_private')).toBe(true);
  });

  it('rejects names no deploy target would take', () => {
    expect(isValidSecretKey('9LEADING')).toBe(false);
    expect(isValidSecretKey('has-dash')).toBe(false);
    expect(isValidSecretKey('has space')).toBe(false);
    expect(isValidSecretKey('')).toBe(false);
  });
});
