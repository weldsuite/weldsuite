import { describe, expect, it } from 'vitest';
import { ArgsError, markdownTarget, parseArgs } from './args';

describe('parseArgs', () => {
  it('defaults to 30 days, every workspace, markdown to stdout, postgres mail source', () => {
    const options = parseArgs([]);
    expect(options).toEqual({
      days: 30,
      workspace: null,
      out: null,
      json: null,
      cloudflare: false,
      redact: false,
      top: 5,
      env: null,
      mailSource: 'postgres',
      help: false,
    });
    expect(markdownTarget(options)).toBe('stdout');
  });

  it('reads every option and ignores a bare -- from pnpm', () => {
    const options = parseArgs([
      '--',
      '--days', '7',
      '--workspace', 'org_123',
      '--out', 'reports/prod.md',
      '--json', 'reports/prod.json',
      '--cloudflare',
      '--redact',
      '--top', '10',
      '--env', 'production',
      '--mail-source', 'auto',
    ]);
    expect(options).toMatchObject({
      days: 7,
      workspace: 'org_123',
      out: 'reports/prod.md',
      json: 'reports/prod.json',
      cloudflare: true,
      redact: true,
      top: 10,
      env: 'production',
      mailSource: 'auto',
    });
    expect(markdownTarget(options)).toEqual({ file: 'reports/prod.md' });
  });

  it('accepts export as a mail source and rejects an unknown one', () => {
    expect(parseArgs(['--mail-source', 'export']).mailSource).toBe('export');
    expect(() => parseArgs(['--mail-source', 'ledger'])).toThrow('--mail-source must be one of postgres, export, auto');
  });

  it('sends JSON to stdout instead of markdown when --json has no file', () => {
    const options = parseArgs(['--json', '--days', '3']);
    expect(options.json).toBe('-');
    expect(options.days).toBe(3);
    expect(markdownTarget(options)).toBe('none');
    expect(markdownTarget(parseArgs(['--json', '-', '--out', 'r.md']))).toEqual({ file: 'r.md' });
  });

  it('rejects bad values and unknown options', () => {
    expect(() => parseArgs(['--days', '0'])).toThrow(ArgsError);
    expect(() => parseArgs(['--days', '400'])).toThrow('--days must be a whole number from 1 to 365');
    expect(() => parseArgs(['--days', '1.5'])).toThrow(ArgsError);
    expect(() => parseArgs(['--workspace'])).toThrow('--workspace needs a value');
    expect(() => parseArgs(['--out', '--json'])).toThrow('--out needs a value');
    expect(() => parseArgs(['--frobnicate'])).toThrow('Unknown option: --frobnicate');
    expect(() => parseArgs(['--out', 'same.txt', '--json', 'same.txt'])).toThrow('different files');
  });

  it('recognises --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
