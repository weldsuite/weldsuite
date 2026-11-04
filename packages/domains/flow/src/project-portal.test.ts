import { describe, expect, it } from 'vitest';
import {
  changeRequestCode,
  documentName,
  nextMilestoneOf,
  portalCodeHash,
  presentReport,
  progressPercent,
  sessionNeedsRefresh,
} from './project-portal';

describe('project portal rules', () => {
  it('formats codes and names', () => {
    expect(changeRequestCode(8)).toBe('CR-8');
    expect(documentName('Plan.docx')).toBe('Plan');
  });

  it('clamps progress', () => {
    expect(progressPercent('58.00')).toBe(58);
    expect(progressPercent('150')).toBe(100);
    expect(progressPercent(null)).toBe(0);
  });

  it('picks the earliest open milestone', () => {
    const d = (s: string) => new Date(s);
    const next = nextMilestoneOf([
      { id: 'a', name: 'A', description: null, dueDate: d('2026-01-01'), status: 'completed' },
      { id: 'c', name: 'C', description: null, dueDate: d('2026-03-01'), status: 'pending' },
      { id: 'b', name: 'B', description: null, dueDate: d('2026-02-01'), status: 'pending' },
    ]);
    expect(next?.id).toBe('b');
  });

  it('keeps reasons and snapshots out of a report', () => {
    const r = presentReport(
      { id: 'r', period: '2026-W45', publishedAt: new Date(0), overall: 'amber', areas: [{ key: 'schedule', colour: 'amber' }, { key: 'x', colour: 'pink' }], summary: 's', done: [{ text: ' a ' }, { text: '' }], next: null },
      null,
    );
    expect(r.areas).toEqual([{ key: 'schedule', colour: 'amber' }]);
    expect(r.done).toEqual(['a']);
  });

  it('salts the code hash and refreshes stale sessions', async () => {
    expect(await portalCodeHash('ws1', 'A@x.nl', '123456')).not.toBe(await portalCodeHash('ws2', 'a@x.nl', '123456'));
    expect(sessionNeedsRefresh(new Date(Date.now() - 2 * 86400000).toISOString(), new Date())).toBe(true);
    expect(sessionNeedsRefresh(new Date().toISOString(), new Date())).toBe(false);
  });
});
