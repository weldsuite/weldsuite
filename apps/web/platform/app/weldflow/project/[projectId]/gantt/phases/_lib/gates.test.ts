import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { GateCheckItem } from '@weldsuite/app-api-client/domains/project-schedule';
import {
  criteriaChanged,
  criterionOf,
  describeCriterion,
  draftComplete,
  draftOf,
  emptyCriterion,
  linkHref,
  moveItem,
  money,
} from './gates';

const copy = en.flowSchedule.phases;

function item(extra: Partial<GateCheckItem>): GateCheckItem {
  return {
    index: 0,
    kind: 'automatic',
    key: 'no_change_request_pending',
    text: null,
    params: null,
    met: false,
    waived: false,
    waiver: null,
    satisfied: false,
    facts: {},
    link: null,
    ...extra,
  };
}

describe('describeCriterion', () => {
  it('words each catalogue criterion from the facts', () => {
    expect(describeCriterion(item({ key: 'deliverable_tasks_done', facts: { code: 'D2', done: 18, total: 31 } }), copy, 'en-US')).toEqual({
      title: 'All tasks of D2 done',
      detail: '18 of 31 tasks done',
    });
    expect(describeCriterion(item({ key: 'deliverable_tasks_done', facts: { code: 'D3', done: 0, total: 0 } }), copy, 'en-US').detail).toBe('No tasks are linked to D3 yet');
    expect(describeCriterion(item({ key: 'deliverable_accepted', facts: { code: 'D1', status: 'in_progress' } }), copy, 'en-US')).toEqual({
      title: 'D1 accepted',
      detail: 'Status: in_progress',
    });
    expect(
      describeCriterion(
        item({ key: 'no_open_risk_above', facts: { band: 'critical', count: 2, top: { code: 'RSK-4', title: 'Data loss', score: 20 } } }),
        copy,
        'en-US',
      ),
    ).toEqual({ title: 'No open critical risks or worse', detail: 'RSK-4 Data loss is still open (score 20), and 1 more' });
    expect(describeCriterion(item({ key: 'no_change_request_pending', facts: { count: 1, first: { code: 'CR-8', title: 'Pay in 3' } } }), copy, 'en-US').detail).toBe(
      'CR-8 Pay in 3 is pending',
    );
  });

  it('shows the spend against the baseline, or that there is no baseline budget', () => {
    const within = describeCriterion(
      item({ key: 'spend_within_baseline', facts: { spent: '104800.00', budget: '186400.00', currency: 'EUR', baselineVersion: 4 } }),
      copy,
      'en-US',
    );
    expect(within.detail).toContain('baseline v4');
    expect(within.detail).toContain('104,800');
    expect(describeCriterion(item({ key: 'spend_within_baseline', facts: { spent: '50.00', budget: null } }), copy, 'en-US').detail).toContain('no baseline budget');
  });

  it('words manual criteria and criteria whose data is gone', () => {
    expect(describeCriterion(item({ kind: 'manual', key: null, text: 'Plan approved', facts: { metAt: null } }), copy, 'en-US')).toEqual({
      title: 'Plan approved',
      detail: 'Ticked by the project manager',
    });
    expect(describeCriterion(item({ kind: 'manual', key: null, text: 'Plan approved', met: true, facts: { metAt: '2026-10-28T09:00:00.000Z' } }), copy, 'en-US').detail).toMatch(/^Marked as met/);
    expect(describeCriterion(item({ key: 'decision_decided', facts: { decisionId: 'dec_1', missing: true } }), copy, 'en-US').detail).toBe('This item no longer exists in the project');
  });
});

describe('links and money', () => {
  it('leads each kind of link to a page of the project', () => {
    expect(linkHref('p1', 'raid')).toBe('/weldflow/project/p1/raid');
    expect(linkHref('p1', 'finance')).toBe('/weldflow/project/p1/finance');
    expect(linkHref('p1', 'decision')).toBe('/weldflow/project/p1/governance/decisions');
  });

  it('formats an amount with its currency, and tolerates junk', () => {
    expect(money('1500.00', 'EUR', 'en-US')).toBe('€1,500');
    expect(money('1500.00', null, 'en-US')).toBe('1,500');
    expect(money('abc', 'EUR', 'en-US')).toBe('abc');
  });
});

describe('criterion drafts', () => {
  it('round-trips a stored criterion through a draft and back', () => {
    for (const stored of [
      { key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_1' } },
      { key: 'no_open_risk_above', params: { band: 'high' } },
      { key: 'decision_decided', params: { decisionId: 'dec_1' } },
      { key: 'no_change_request_pending' },
      { manual: 'Plan approved', met: true, metAt: '2026-11-01T00:00:00.000Z' },
    ]) {
      const back = criterionOf(draftOf(stored));
      expect(back).toEqual('manual' in stored ? { manual: stored.manual } : stored);
    }
  });

  it('knows when a draft is complete', () => {
    expect(draftComplete(emptyCriterion('manual'))).toBe(false);
    expect(draftComplete({ ...emptyCriterion('manual'), text: ' Plan ' })).toBe(true);
    expect(draftComplete(emptyCriterion('deliverable_accepted'))).toBe(false);
    expect(draftComplete({ ...emptyCriterion('deliverable_accepted'), deliverableId: 'd' })).toBe(true);
    expect(draftComplete(emptyCriterion('no_change_request_pending'))).toBe(true);
  });

  it('sees whether editing changed the criteria', () => {
    const stored = [{ manual: 'Plan', met: true, metAt: 'x' }, { key: 'no_change_request_pending' }];
    expect(criteriaChanged(stored, stored.map(draftOf))).toBe(false);
    expect(criteriaChanged(stored, [draftOf(stored[0]), { ...emptyCriterion('manual'), text: 'Other' }])).toBe(true);
    expect(criteriaChanged(stored, [draftOf(stored[0])])).toBe(true);
  });

  it('moves an entry up or down, and stays put at the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
