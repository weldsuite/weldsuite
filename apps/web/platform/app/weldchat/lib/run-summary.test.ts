import { describe, expect, it } from 'vitest';
import { runSummaryText } from './run-summary';

describe('runSummaryText', () => {
  it('drops bold and code markers', () => {
    expect(runSummaryText('Created **QA agent chat task** in `Sprint 4`')).toBe('Created QA agent chat task in Sprint 4');
  });

  it('flattens a list into one line without its bullets', () => {
    expect(runSummaryText('Done:\n- **Task** created\n- Owner set\n1. Notified')).toBe(
      'Done: Task created Owner set Notified',
    );
  });

  it('drops heading, quote and fence markers', () => {
    expect(runSummaryText('## Summary\n> quoted\n```\ncode\n```')).toBe('Summary quoted code');
  });

  it('shows mentions as @Name', () => {
    expect(runSummaryText('Asked <@user_1:Gert> to review')).toBe('Asked @Gert to review');
  });

  it('keeps a line that merely starts with bold text', () => {
    expect(runSummaryText('**Note:** it worked')).toBe('Note: it worked');
  });

  it('is empty for nothing', () => {
    expect(runSummaryText(undefined)).toBe('');
    expect(runSummaryText(null)).toBe('');
    expect(runSummaryText('')).toBe('');
  });
});
