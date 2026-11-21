/**
 * The file name of a saved report's CSV (`reportCsvFilename`): the slug of the
 * title, or the report id when the title leaves nothing. Pure, no database.
 */

import { describe, expect, it } from 'vitest';
import { reportCsvFilename } from './desk-report-export';

const NOW = new Date('2026-03-15T10:00:00Z');
const name = (title: string) => reportCsvFilename({ id: 'rpt_1', title }, NOW);

describe('reportCsvFilename', () => {
  it('lower-cases the title and turns every run of other characters into one dash', () => {
    expect(name('Weekly volume (Q1)')).toBe('welddesk-report-weekly-volume-q1-2026-03-15.csv');
    expect(name('  SLA -- breaches / week  ')).toBe('welddesk-report-sla-breaches-week-2026-03-15.csv');
    expect(name('Réponses été 2026')).toBe('welddesk-report-r-ponses-t-2026-2026-03-15.csv');
  });

  it('cuts the slug at 40 characters and drops a dash the cut leaves at the end', () => {
    expect(name('a'.repeat(45))).toBe(`welddesk-report-${'a'.repeat(40)}-2026-03-15.csv`);
    expect(name(`${'a'.repeat(39)} b`)).toBe(`welddesk-report-${'a'.repeat(39)}-2026-03-15.csv`);
    expect(name(`${'a'.repeat(38)} b c`)).toBe(`welddesk-report-${'a'.repeat(38)}-b-2026-03-15.csv`);
  });

  it('uses the report id when the title leaves nothing', () => {
    expect(name('')).toBe('welddesk-report-rpt_1-2026-03-15.csv');
    expect(name('---')).toBe('welddesk-report-rpt_1-2026-03-15.csv');
    expect(name('!!! ???')).toBe('welddesk-report-rpt_1-2026-03-15.csv');
  });

  it('handles a long run of separators', () => {
    const title = `${'-'.repeat(50_000)}Queue${' _.'.repeat(50_000)}load${'-'.repeat(50_000)}`;
    expect(name(title)).toBe('welddesk-report-queue-load-2026-03-15.csv');
    expect(name('-'.repeat(200_000))).toBe('welddesk-report-rpt_1-2026-03-15.csv');
  });
});
